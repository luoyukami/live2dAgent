/**
 * ToolResultLimiter — limits tool result output sent back to the model.
 *
 * When a tool's raw output exceeds the inline character limit, the limiter:
 *   1. Persists the full output via an injectable ArtifactWriter.
 *   2. Returns a JSON string containing summary, head+tail, omitted count,
 *      and artifactRef.
 *
 * The JSON output format is:
 * ```json
 * {
 *   "status": "ok",
 *   "summary": "...",
 *   "content": "head...\n\n[omitted X chars]\n\ntail...",
 *   "artifactRef": "artifact://tool-output/xxx"
 * }
 * ```
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §9.6.
 */

import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"

/* ------------------------------------------------------------------ */
/*  ArtifactWriter interface                                            */
/* ------------------------------------------------------------------ */

export interface ArtifactMeta {
  id: string
  path: string
  size: number
}

/**
 * Injectable writer for persisting full tool output to an artifact store.
 * The real Electron implementation writes to disk; tests use a mock.
 */
export interface ArtifactWriter {
  writeArtifact(
    name: string,
    content: string,
    mimeType?: string,
  ): Promise<ArtifactMeta>
}

/* ------------------------------------------------------------------ */
/*  LimitedOutput — the result of limiting                             */
/* ------------------------------------------------------------------ */

/**
 * The result of applying ToolResultLimiter to a tool output.
 */
export interface LimitedOutput {
  /**
   * JSON string to send to the model as the tool result output.
   * Contains status, summary, head+tail content, omitted chars, and artifactRef.
   */
  output: string
  /** Full original length before limiting. */
  fullLength: number
  /** Artifact reference ID if full output was persisted. */
  artifactRef?: string
}

/* ------------------------------------------------------------------ */
/*  ToolResultLimiter                                                   */
/* ------------------------------------------------------------------ */

export interface ToolResultLimiterOptions {
  inlineCharLimit?: number
  summaryCharLimit?: number
  headChars?: number
  tailChars?: number
  artifactWriter?: ArtifactWriter
}

/**
 * Limits tool result output to safe sizes for model consumption.
 *
 * Default limits (from WS_RUNTIME_CONSTANTS):
 *   - inline:    8,000 chars
 *   - summary:   1,200 chars
 *   - head:      3,000 chars
 *   - tail:      3,000 chars
 */
export class ToolResultLimiter {
  private readonly inlineCharLimit: number
  private readonly summaryCharLimit: number
  private readonly headChars: number
  private readonly tailChars: number
  private readonly artifactWriter?: ArtifactWriter

  constructor(options: ToolResultLimiterOptions = {}) {
    this.inlineCharLimit = options.inlineCharLimit ?? WS_RUNTIME_CONSTANTS.TOOL_RESULT_INLINE_CHAR_LIMIT
    this.summaryCharLimit = options.summaryCharLimit ?? WS_RUNTIME_CONSTANTS.TOOL_RESULT_SUMMARY_CHAR_LIMIT
    this.headChars = options.headChars ?? WS_RUNTIME_CONSTANTS.TOOL_RESULT_HEAD_CHARS
    this.tailChars = options.tailChars ?? WS_RUNTIME_CONSTANTS.TOOL_RESULT_TAIL_CHARS
    this.artifactWriter = options.artifactWriter
  }

  /**
   * Limit a tool output.
   *
   * If the output fits within the inline limit, returns it as a plain JSON
   * with the full content. If it exceeds the inline limit, truncates,
   * persists via artifactWriter, and returns a JSON with head/tail/ref.
   *
   * @param toolName - Name of the tool (used for artifact naming).
   * @param content  - Raw output from tool execution.
   * @param status   - Execution status ("ok", "error", or "denied").
   * @returns A LimitedOutput containing the JSON payload for the model.
   */
  async limit(
    toolName: string,
    content: string,
    status: "ok" | "error" | "denied" = "ok",
  ): Promise<LimitedOutput> {
    const fullLength = content.length

    if (fullLength <= this.inlineCharLimit) {
      // Fits inline — return as-is
      return {
        output: JSON.stringify({
          status,
          summary: content,
          content,
        }),
        fullLength,
      }
    }

    // Generate summary (first N chars)
    const summary = content.slice(0, this.summaryCharLimit)

    // Build head + tail content
    const head = content.slice(0, this.headChars)
    const tail = content.slice(-this.tailChars)
    const omitted = fullLength - this.headChars - this.tailChars

    let artifactRef: string | undefined

    // Persist full output via artifact writer if available
    if (this.artifactWriter) {
      try {
        const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const meta = await this.artifactWriter.writeArtifact(
          `tool_output_${safeName}_${Date.now()}`,
          content,
          "text/plain",
        )
        artifactRef = `artifact://tool-output/${meta.id}`
      } catch {
        // Non-fatal: fall back to truncated content without artifact ref
      }
    }

    const contentForModel = `${head}\n\n[omitted ${omitted} chars]\n\n${tail}`

    const payload = {
      status,
      summary,
      content: contentForModel,
      artifactRef,
    }

    return {
      output: JSON.stringify(payload),
      fullLength,
      artifactRef,
    }
  }
}
