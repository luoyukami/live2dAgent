/**
 * Provider-neutral model event types.
 *
 * These events are emitted by a ProviderRuntime implementation and
 * consumed by AssistantRuntime. Every provider adapter must convert
 * its own protocol-level events into this shape.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §6.5 / §8.5.
 */

/* ------------------------------------------------------------------ */
/*  TokenUsage                                                         */
/* ------------------------------------------------------------------ */

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/* ------------------------------------------------------------------ */
/*  ModelError                                                         */
/* ------------------------------------------------------------------ */

export interface ModelError {
  code: string
  message: string
  retryable: boolean
}

/* ------------------------------------------------------------------ */
/*  ModelEvent                                                         */
/* ------------------------------------------------------------------ */

/**
 * Events emitted during a model interaction.
 *
 * A ProviderRuntime yields these via its `create()` and
 * `continueWithToolResult()` methods.
 */
export type ModelEvent =
  | { type: "response.created"; responseId: string }
  | { type: "text.delta"; responseId: string; delta: string }
  | { type: "tool.call"; responseId: string; callId: string; name: string; argumentsText: string }
  | { type: "response.completed"; responseId: string; usage?: TokenUsage }
  | { type: "response.failed"; error: ModelError }
  | { type: "response.cancelled"; responseId: string }
