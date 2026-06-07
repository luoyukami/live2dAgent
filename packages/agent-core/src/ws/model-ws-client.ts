/**
 * ModelWsClient interface — the abstract contract for a provider-specific
 * WebSocket client.
 *
 * Every real provider adapter (OpenAI, Anthropic, etc.) must implement this
 * interface. The adapter is responsible for:
 *   - Opening the WS connection
 *   - Sending session init
 *   - Sending user input & tool results
 *   - Receiving & converting provider events into {@link ModelWsEvent}
 *   - Sending cancel signals
 *   - Closing the connection
 *
 * This module MUST NOT import UI, conversation store, or tool runtime.
 *
 * See docs/ws_model_communication_architecture.md §9.
 */
import type {
  ModelWsEvent,
  ModelWsConnectConfig,
  ModelWsSessionInit,
  ModelWsCreateResponseInput,
  ModelWsToolResultInput,
  ModelWsCancelInput,
  ModelWsCloseInput,
} from "./ws-types.js"

export type { ModelWsEvent }
export type {
  ModelWsConnectConfig,
  ModelWsSessionInit,
  ModelWsCreateResponseInput,
  ModelWsToolResultInput,
  ModelWsCancelInput,
  ModelWsCloseInput,
}

/** Listener signature for ModelWsEvent. */
export type ModelWsEventListener = (event: ModelWsEvent) => void

/** Unsubscribe function returned by `onEvent`. */
export type ModelWsEventUnsubscribe = () => void

/**
 * Abstract WebSocket client for model communication.
 *
 * Implementations live in their respective provider packages
 * (e.g. `packages/model-openai-compatible/src/ws/`).
 */
export interface ModelWsClient {
  /** Open the WS connection. */
  connect(config: ModelWsConnectConfig): Promise<void>

  /** Initialise the session after connection is established. */
  initSession(input: ModelWsSessionInit): Promise<void>

  /** Send a user message / context to start (or continue) a model response. */
  createResponse(input: ModelWsCreateResponseInput): Promise<void>

  /** Send a tool execution result back to the model. */
  sendToolResult(input: ModelWsToolResultInput): Promise<void>

  /** Cancel the currently active response. */
  cancelResponse(input: ModelWsCancelInput): Promise<void>

  /** Send a ping to keep the connection alive. */
  ping(): void | Promise<void>

  /** Gracefully close the connection. */
  close(input: ModelWsCloseInput): Promise<void>

  /** Subscribe to events from the underlying WS. Returns an unsubscribe function. */
  onEvent(listener: ModelWsEventListener): ModelWsEventUnsubscribe
}
