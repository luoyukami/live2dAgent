/**
 * Tool Runtime — core abstractions for tool call processing.
 *
 * Provides:
 *   - ToolCallValidator: validates tool call arguments against registered schemas
 *   - ToolOutputTruncator: truncates long outputs with summary + head/tail + artifactRef
 *   - ArtifactWriter: injectable interface for persisting full output (mock in tests)
 *   - processToolCalls: orchestrates validation, permission check, execution, truncation
 *
 * All types are runtime-agnostic — no Electron / Node / DOM dependencies.
 */
import type { ToolDefinition } from "../types.js"
import type { WsToolCall, WsToolResult } from "../ws/ws-types.js"
import { ToolRegistry } from "../tool-registry.js"
import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"

/* ------------------------------------------------------------------ */
/*  ArtifactWriter — injectable, mockable in tests                     */
/* ------------------------------------------------------------------ */

export interface ArtifactMeta {
  id: string
  path: string
  size: number
}

/**
 * Interface for persisting tool output artifacts.
 * The real Electron implementation writes to disk; the test mock captures in memory.
 */
export interface ArtifactWriter {
  writeArtifact(
    name: string,
    content: string,
    mimeType?: string,
  ): Promise<ArtifactMeta>
}

/* ------------------------------------------------------------------ */
/*  Validation result                                                  */
/* ------------------------------------------------------------------ */

export interface ValidationResult {
  valid: boolean
  error?: string
}

/* ------------------------------------------------------------------ */
/*  Truncation result                                                  */
/* ------------------------------------------------------------------ */

export interface TruncatedOutput {
  /** Short summary for the model to understand the result shape. */
  summary: string
  /**
   * Content to send to the model (truncated to inline limit).
   * Includes head + tail when the original exceeds the limit.
   */
  contentForModel: string
  /** Total length of the original output before truncation. */
  fullLength: number
  /** Artifact reference ID if the full output was persisted. */
  artifactRef?: string
}

/* ------------------------------------------------------------------ */
/*  Tool call processing result                                        */
/* ------------------------------------------------------------------ */

export interface ToolCallProcessResult {
  toolCallId: string
  result: WsToolResult
}

/* ------------------------------------------------------------------ */
/*  ToolCallValidator — argument validation against schemas             */
/* ------------------------------------------------------------------ */

export class ToolCallValidator {
  /**
   * Validate a tool call's arguments against its registered schema.
   *
   * Performs:
   *   1. Check the tool exists in the registry.
   *   2. Verify arguments is a plain object (when required).
   *   3. Check required top-level properties are present.
   *
   * Returns `{ valid: true }` or `{ valid: false, error }`.
   */
  validate(
    toolName: string,
    args: unknown,
    registry: ToolRegistry,
  ): ValidationResult {
    const def = registry.get(toolName)
    if (!def) {
      return { valid: false, error: `Unknown tool "${toolName}"` }
    }

    const schema = def.inputSchema as Record<string, unknown> | undefined
    if (!schema) {
      return { valid: true } // No schema to validate against
    }

    // Quick structural validation for common patterns.
    // For full JSON Schema validation, the host should provide a schema
    // validator (e.g. ajv). This is a lightweight alternative that catches
    // the most common mistakes (missing required properties, wrong types).
    if (schema.type === "object" && schema.required && Array.isArray(schema.required)) {
      if (typeof args !== "object" || args === null) {
        return { valid: false, error: `Arguments for "${toolName}" must be a plain object` }
      }
      const record = args as Record<string, unknown>
      for (const key of schema.required as string[]) {
        if (!(key in record)) {
          return { valid: false, error: `Missing required argument "${key}" for tool "${toolName}"` }
        }
      }
    }

    // Validate properties types if `properties` is present
    if (schema.type === "object" && schema.properties && typeof args === "object" && args !== null) {
      const props = schema.properties as Record<string, { type?: string }>
      const record = args as Record<string, unknown>
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in record && propSchema.type && record[key] !== null && record[key] !== undefined) {
          const value = record[key]
          const typeError = this.checkType(value, propSchema.type)
          if (typeError) {
            return { valid: false, error: `Argument "${key}" for tool "${toolName}": ${typeError}` }
          }
        }
      }
    }

    return { valid: true }
  }

  private checkType(value: unknown, expectedType: string): string | null {
    switch (expectedType) {
      case "string":
        return typeof value === "string" ? null : `expected string, got ${typeof value}`
      case "number":
      case "integer":
        return typeof value === "number" ? null : `expected number, got ${typeof value}`
      case "boolean":
        return typeof value === "boolean" ? null : `expected boolean, got ${typeof value}`
      case "array":
        return Array.isArray(value) ? null : `expected array, got ${typeof value}`
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? null
          : `expected object, got ${typeof value}`
      default:
        return null // Unknown type — skip validation
    }
  }
}

/* ------------------------------------------------------------------ */
/*  ToolOutputTruncator — truncation with artifactRef support          */
/* ------------------------------------------------------------------ */

export class ToolOutputTruncator {
  constructor(
    private readonly options: {
      /** Max chars of tool result inlined directly into model input. */
      inlineCharLimit: number
      /** Max chars of tool result summary sent to model. */
      summaryCharLimit: number
      /** Optional writer for persisting the full output. */
      artifactWriter?: ArtifactWriter
    },
  ) {}

  /**
   * Truncate tool output to fit within inline limits.
   *
   * Strategy:
   *   - If content fits inline: return as-is.
   *   - If content exceeds inline limit:
   *       * Generate a summary (first N chars).
   *       * Keep head + tail of the output.
   *       * Optionally persist full output as an artifact (when ArtifactWriter
   *         is configured).
   *       * Set artifactRef in the result.
   */
  async truncate(
    toolName: string,
    content: string,
  ): Promise<TruncatedOutput> {
    const fullLength = content.length

    if (fullLength <= this.options.inlineCharLimit) {
      return {
        summary: content,
        contentForModel: content,
        fullLength,
      }
    }

    // Generate summary (first N chars)
    const summary = content.slice(0, this.options.summaryCharLimit)

    // Build head + tail content
    const halfInline = Math.floor(this.options.inlineCharLimit / 2)
    const head = content.slice(0, halfInline)
    const tail = content.slice(-halfInline)
    const truncatedChars = fullLength - this.options.inlineCharLimit
    const headTailContent = `${head}\n\n[... truncated ${truncatedChars} chars ...]\n\n${tail}`

    // Persist full output as artifact if writer is available
    let artifactRef: string | undefined
    if (this.options.artifactWriter) {
      try {
        const meta = await this.options.artifactWriter.writeArtifact(
          `tool_output_${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
          content,
          "text/plain",
        )
        artifactRef = meta.id
      } catch {
        // Non-fatal: fall back to just the truncated content
      }
    }

    return {
      summary,
      contentForModel: headTailContent,
      fullLength,
      artifactRef,
    }
  }

  /**
   * Generate a status: "denied" WsToolResult for a permission-denied tool call.
   */
  deniedResult(
    toolCallId: string,
    toolName: string,
    reason: string,
  ): WsToolResult {
    return {
      toolCallId,
      status: "denied",
      summary: `Permission denied for ${toolName}: ${reason}`,
      contentForModel: `Tool ${toolName} was denied: ${reason}`,
    }
  }

  /**
   * Generate a status: "error" WsToolResult for an invalid-arguments tool call.
   */
  invalidArgumentsResult(
    toolCallId: string,
    toolName: string,
    error: string,
  ): WsToolResult {
    return {
      toolCallId,
      status: "error",
      summary: `Invalid arguments for ${toolName}: ${error}`,
      contentForModel: `Tool ${toolName} was called with invalid arguments and was not executed.\nError: ${error}`,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  ProcessToolCalls — orchestrates the full tool call pipeline        */
/* ------------------------------------------------------------------ */

export interface ProcessToolCallsInput {
  toolCalls: WsToolCall[]
  toolRegistry: ToolRegistry
  /** ToolRuntime from the host (Electron main process, or mock in tests). */
  runtime: {
    executeMany(
      calls: Array<{ id: string; tool: string; args: unknown }>,
    ): Promise<Array<{ id: string; ok: boolean; content: string; data?: unknown }>>
  }
  /** Permission controller from the host. */
  permission: {
    check(
      actions: Array<{ id: string; tool: string; args: unknown }>,
    ): Promise<{ status: "approved" | "denied"; actions: Array<{ id: string; tool: string; args: unknown }>; reason?: string }>
  }
  /** Optional artifact writer for persisting truncated output. */
  artifactWriter?: ArtifactWriter
  /** Inline char limit (default: WS_RUNTIME_CONSTANTS.TOOL_RESULT_INLINE_CHAR_LIMIT). */
  inlineCharLimit?: number
  /** Summary char limit (default: WS_RUNTIME_CONSTANTS.TOOL_RESULT_SUMMARY_CHAR_LIMIT). */
  summaryCharLimit?: number
}

/**
 * Process a batch of tool calls through the full pipeline:
 *   validate → permission check → execute → truncate → WsToolResult[]
 *
 * Returns one WsToolResult per input WsToolCall in the same order.
 */
export async function processToolCalls(
  input: ProcessToolCallsInput,
): Promise<ToolCallProcessResult[]> {
  const {
    toolCalls,
    toolRegistry,
    runtime,
    permission,
    artifactWriter,
    inlineCharLimit = WS_RUNTIME_CONSTANTS.TOOL_RESULT_INLINE_CHAR_LIMIT,
    summaryCharLimit = WS_RUNTIME_CONSTANTS.TOOL_RESULT_SUMMARY_CHAR_LIMIT,
  } = input

  const validator = new ToolCallValidator()
  const truncator = new ToolOutputTruncator({
    inlineCharLimit,
    summaryCharLimit,
    artifactWriter,
  })

  const results: ToolCallProcessResult[] = []

  // Phase 1: Validate all tool calls first
  const validCalls: Array<{ call: WsToolCall; index: number }> = []
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!
    const validation = validator.validate(call.name, call.arguments, toolRegistry)
    if (!validation.valid) {
      results[i] = {
        toolCallId: call.id,
        result: truncator.invalidArgumentsResult(call.id, call.name, validation.error!),
      }
    } else {
      validCalls.push({ call, index: i })
    }
  }

  // Phase 2: Permission check for valid calls
  if (validCalls.length > 0) {
    const actions = validCalls.map(({ call }) => ({
      id: call.id,
      tool: call.name,
      args: call.arguments as Record<string, unknown>,
    }))

    const decision = await permission.check(actions)

    const deniedIds = new Set<string>()
    if (decision.status === "denied") {
      for (const action of decision.actions) {
        deniedIds.add(action.id)
      }
    }

    // Separate approved and denied calls
    const approvedCalls = validCalls.filter(({ call }) => !deniedIds.has(call.id))
    const deniedCalls = validCalls.filter(({ call }) => deniedIds.has(call.id))

    // Phase 3: Execute approved calls
    if (approvedCalls.length > 0) {
      const execInputs = approvedCalls.map(({ call }) => ({
        id: call.id,
        tool: call.name,
        args: call.arguments as Record<string, unknown>,
      }))

      let execResults: Array<{ id: string; ok: boolean; content: string; data?: unknown }>
      try {
        execResults = await runtime.executeMany(execInputs)
      } catch (err) {
        // Runtime error — all approved calls fail
        execResults = execInputs.map((input) => ({
          id: input.id,
          ok: false,
          content: err instanceof Error ? err.message : "Tool execution failed",
        }))
      }

      const resultByCallId = new Map(execResults.map((r) => [r.id, r]))

      // Phase 4: Truncate output and build results
      for (const { call } of approvedCalls) {
        const execResult = resultByCallId.get(call.id)
        if (!execResult) {
          const truncated = await truncator.truncate(call.name, "No execution result")
          results[findIndex(toolCalls, call.id)] = {
            toolCallId: call.id,
            result: {
              toolCallId: call.id,
              status: "error",
              summary: truncated.summary,
              contentForModel: `Tool ${call.name} execution returned no result.\n${truncated.contentForModel}`,
              artifactRef: truncated.artifactRef,
            },
          }
          continue
        }

        const truncated = await truncator.truncate(call.name, execResult.content)
        results[findIndex(toolCalls, call.id)] = {
          toolCallId: call.id,
          result: {
            toolCallId: call.id,
            status: execResult.ok ? "ok" : "error",
            summary: truncated.summary.slice(0, summaryCharLimit),
            contentForModel: truncated.contentForModel,
            artifactRef: truncated.artifactRef,
            metadata: execResult.ok ? undefined : { errorCode: "execution_error" },
          },
        }
      }
    }

    // Phase 5: Build denied results
    for (const { call } of deniedCalls) {
      results[findIndex(toolCalls, call.id)] = {
        toolCallId: call.id,
        result: truncator.deniedResult(call.id, call.name, decision.reason ?? "Permission denied"),
      }
    }
  }

  // Fill any gaps (should not happen, but defensive)
  for (let i = 0; i < toolCalls.length; i++) {
    if (!results[i]) {
      results[i] = {
        toolCallId: toolCalls[i]!.id,
        result: {
          toolCallId: toolCalls[i]!.id,
          status: "error",
          summary: "Unknown processing error",
          contentForModel: "An internal error occurred while processing this tool call.",
        },
      }
    }
  }

  return results
}

function findIndex(calls: WsToolCall[], callId: string): number {
  return calls.findIndex((c) => c.id === callId)
}
