/* ---- Types ---- */
export type {
  AgentMessage,
  AgentMessageMetadata,
  AgentAction,
  ToolResult,
  ToolDefinition,
  AgentEvent,
  AgentEventCallback,
  Unsubscribe,
  ToolName,
  PermissionLevel,
  AgentMode,
  ToolArtifact,
  MultimodalContent,
  ArtifactRef,
  AudioContextAttachment,
  Emotion,
  EmotionSource,
} from "./types.js"

/* ---- Core classes / interfaces ---- */
export { EventBus } from "./events.js"
export type { ModelAdapter } from "./model-adapter.js"
export { ToolRegistry } from "./tool-registry.js"
export type { ToolRuntime, PermissionController, TraceStore } from "./agent-session.js"
export { AgentSession } from "./agent-session.js"

/* ---- Utilities ---- */
export { formatToolResultsAsObservations } from "./observation-formatter.js"

/* ---- Emotion subsystem ---- */
export {
  parseEmotionTag,
  emotionSettingsForParsing,
} from "./emotion-parser.js"
export type {
  ParseEmotionTagOptions,
  ParsedEmotionMessage,
  EmotionSource as ParsedEmotionSource,
} from "./emotion-parser.js"
export {
  getEmotionTagInstructions,
  composeSystemPrompt,
  isEmotionPromptInjected,
  listEmotionValues,
  EMOTION_PROMPT_MARKER,
} from "./emotion-prompt.js"

/* ---- WS Runtime (Phase 1) ---- */
export { WS_RUNTIME_CONSTANTS } from "./ws/ws-runtime-constants.js"
export { createRuntimeError, RuntimeErrors } from "./ws/ws-errors.js"
export type { RuntimeErrorPayload, RuntimeErrorCode } from "./ws/ws-errors.js"
export type {
  RemoteContextId,
  WsToolCall,
  WsToolResult,
  ModelWsEvent,
  AgentRuntimeEvent,
  WsSessionState,
  WsSession,
  AgentRunStatus,
  AgentRun,
  ModelWsConnectConfig,
  ModelWsSessionInit,
  ModelWsCreateResponseInput,
  ModelWsToolResultInput,
  ModelWsCancelInput,
  ModelWsCloseInput,
} from "./ws/ws-types.js"
export type {
  ModelWsClient,
  ModelWsEventListener,
  ModelWsEventUnsubscribe,
} from "./ws/model-ws-client.js"

/* ---- Conversation Manager ---- */
export { ConversationManager } from "./conversation/conversation-manager.js"
export type { ConversationMessage, Conversation } from "./conversation/conversation-manager.js"

/* ---- WsSessionManager ---- */
export { WsSessionManager, ALLOWED_TRANSITIONS } from "./ws/ws-session-manager.js"
export type { RuntimeEventCallback, RuntimeEventUnsubscribe, WsSessionManagerOptions } from "./ws/ws-session-manager.js"

/* ---- RunController ---- */
export { RunController } from "./runtime/run-controller.js"
