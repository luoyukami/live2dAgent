export type { OpenAiCompatibleAdapterConfig } from "./openai-compatible-adapter.js"
export { OpenAiCompatibleAdapter } from "./openai-compatible-adapter.js"
export type { OpenAiCompatibleWsClientConfig, MinimalWebSocketConstructor } from "./ws/openai-compatible-ws-client.js"
export { OpenAiCompatibleWsClient } from "./ws/openai-compatible-ws-client.js"
export type { OpenAiCompatibleWsProtocol, OpenAiCompatibleWsOutboundMessage } from "./ws/openai-compatible-ws-protocol.js"
export { JsonModelWsProtocol } from "./ws/openai-compatible-ws-protocol.js"

/* ---- MiMo WS Runtime (Phase 2) ---- */
export { NodeWsConnectionImpl } from "./ws/node-ws-connection.js"
export type { NodeWsConnection, WsConnectInput, WsCloseEvent, Unsubscribe } from "./ws/node-ws-connection.js"
export { encodeTools } from "./ws/mimo-tool-schema-encoder.js"
export type { ProviderToolSchema } from "./ws/mimo-tool-schema-encoder.js"
export { encodeContent } from "./ws/mimo-content-encoder.js"
export type { ProviderContentPart } from "./ws/mimo-content-encoder.js"
export {
  decodeFrame,
  ToolCallArgumentAggregator,
} from "./ws/mimo-event-decoder.js"
export { MimoWsProtocol } from "./ws/mimo-ws-protocol.js"
export type { MimoCreateRequest, ProviderInputItem } from "./ws/mimo-ws-protocol.js"
export { MimoWsRuntime, RuntimeError } from "./ws/mimo-ws-runtime.js"
/* Re-export canonical types from agent-core */
export type {
  ProviderRuntime,
  ProviderRuntimeState,
  CanonicalCreateInput,
  CanonicalToolContinuationInput,
  CanonicalToolResult,
  ModelEvent,
  TokenUsage,
  ModelError,
  ModelContentPart,
  ModelMessage,
  CanonicalToolDefinition,
} from "@live2d-agent/agent-core"
export { UnsupportedInputPartError, ProtocolDecodeError, ConnectionStateError } from "./ws/mimo-errors.js"
