/**
 * Provider-neutral runtime interfaces.
 *
 * ProviderRuntime is the abstract interface that every provider
 * (MiMo, OpenAI-compatible, etc.) implements. It is consumed by
 * AssistantRuntime and never exposed to Renderer.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §6.5–§6.7.
 */

import type { ModelMessage } from "./model-message.js"
import type { ModelEvent } from "./model-event.js"
import type { CanonicalToolDefinition, CanonicalToolResult } from "./model-tool.js"

/* ------------------------------------------------------------------ */
/*  ProviderRuntimeState                                               */
/* ------------------------------------------------------------------ */

export interface ProviderRuntimeState {
  status: "disconnected" | "connecting" | "connected" | "closed" | "error"
  conversationId: string | null
  remoteResponseId: string | null
  connectedAt: number | null
  error?: { code: string; message: string }
}

/* ------------------------------------------------------------------ */
/*  CanonicalCreateInput                                               */
/* ------------------------------------------------------------------ */

/**
 * Input for the initial `create()` call on a ProviderRuntime.
 */
export interface CanonicalCreateInput {
  conversationId: string
  runId: string
  model: string

  /** Optional remote response ID from a previous run for continuation. */
  remoteResponseId?: string | null

  messages: ModelMessage[]
  tools: CanonicalToolDefinition[]

  toolChoice: "auto" | "none" | "required"
  parallelToolCalls: false

  maxOutputTokens: number
}

/* ------------------------------------------------------------------ */
/*  CanonicalToolContinuationInput                                     */
/* ------------------------------------------------------------------ */

/**
 * Input for continuing a model interaction with a tool result.
 */
export interface CanonicalToolContinuationInput {
  conversationId: string
  runId: string
  model: string

  /** Previous response ID for remote context continuation. */
  previousResponseId: string | null

  toolResult: CanonicalToolResult
  tools: CanonicalToolDefinition[]

  parallelToolCalls: false
  maxOutputTokens: number
}

/* ------------------------------------------------------------------ */
/*  ProviderRuntime                                                    */
/* ------------------------------------------------------------------ */

/**
 * Abstract interface for a provider-specific model runtime.
 *
 * Implementations manage a WebSocket (or HTTP) connection to the
 * model provider and translate between canonical types and the
 * provider's wire format.
 *
 * All methods are async and may throw RuntimeErrorPayload-compatible
 * errors.
 */
export interface ProviderRuntime {
  /** Open a connection for the given conversation. */
  open(conversationId: string): Promise<void>

  /**
   * Create a new model response. Yields ModelEvent items as the
   * provider streams back text deltas, tool calls, etc.
   */
  create(input: CanonicalCreateInput): AsyncIterable<ModelEvent>

  /**
   * Continue the current interaction with a tool result.
   * Yields ModelEvent items as above.
   */
  continueWithToolResult(input: CanonicalToolContinuationInput): AsyncIterable<ModelEvent>

  /** Cancel an in-progress response. */
  cancel(input: { responseId?: string; runId: string }): Promise<void>

  /** Close the connection with an optional reason. */
  close(reason: string): Promise<void>

  /** Return the current state of this runtime instance. */
  getState(): ProviderRuntimeState
}
