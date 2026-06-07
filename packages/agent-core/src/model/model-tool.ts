/**
 * Provider-neutral tool types.
 *
 * These types separate internal tool definitions (which carry
 * permission, timeout, and execution logic) from the canonical
 * definitions that are safe to send to a model.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §6.3–§6.4, §9.
 */

/* ------------------------------------------------------------------ */
/*  JsonSchema (minimal)                                               */
/* ------------------------------------------------------------------ */

/**
 * A minimal JSON Schema representation used for tool parameters.
 */
export type JsonSchema =
  | {
      type: "object" | "string" | "number" | "integer" | "boolean" | "array"
      description?: string
      properties?: Record<string, JsonSchema>
      required?: string[]
      items?: JsonSchema
      enum?: string[]
    }
  | { [key: string]: unknown }

/* ------------------------------------------------------------------ */
/*  CanonicalToolDefinition                                            */
/* ------------------------------------------------------------------ */

/**
 * Tool definition as seen by the model — only name, description, and
 * parameter schema. Internal fields (permission, execute, timeoutMs,
 * riskLevel) are stripped before sending.
 */
export interface CanonicalToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
}

/* ------------------------------------------------------------------ */
/*  CanonicalToolResult                                                */
/* ------------------------------------------------------------------ */

/**
 * Result of a tool execution, ready for model consumption.
 *
 * `output` is the primary content sent to the model (possibly truncated).
 * `summary` is a shorter textual summary.
 * `artifactRef` points to the full output if it was persisted externally.
 */
export interface CanonicalToolResult {
  callId: string
  name: string
  status: "ok" | "error" | "denied"
  output: string
  summary: string
  artifactRef?: string
  metadata?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  InternalToolDefinition                                             */
/* ------------------------------------------------------------------ */

/**
 * Full internal tool definition used by ToolManager.
 *
 * Contains runtime metadata that MUST NOT be sent to the model.
 */
export interface InternalToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema

  permission: string
  timeoutMs: number

  execute(args: unknown, context: ModelToolContext): Promise<ToolExecutionResult>
}

/* ------------------------------------------------------------------ */
/*  ModelToolContext                                                    */
/* ------------------------------------------------------------------ */

/**
 * Context passed to InternalToolDefinition.execute().
 * This is distinct from the RunController's ToolExecutionContext.
 */
export interface ModelToolContext {
  runId: string
  conversationId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/* ------------------------------------------------------------------ */
/*  ToolExecutionResult                                                */
/* ------------------------------------------------------------------ */

export interface ToolExecutionResult {
  ok: boolean
  content: string
  data?: unknown
}

/* ------------------------------------------------------------------ */
/*  ModelToolCall / ValidatedToolCall                                   */
/* ------------------------------------------------------------------ */

/**
 * A tool call as received from the model event stream.
 */
export interface ModelToolCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * A tool call that passed validation.
 */
export interface ValidatedToolCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}
