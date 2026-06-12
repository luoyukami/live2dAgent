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
  composePromptPresetInstructions,
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
export type { RuntimeEventCallback, RuntimeEventUnsubscribe, WsSessionManagerOptions, ModelWsClientFactory, ModelEventCallback, ModelEventUnsubscribe } from "./ws/ws-session-manager.js"

/* ---- RunController ---- */
export { RunController } from "./runtime/run-controller.js"
export type { ToolExecutionContext, ToolPermissionContext, RunControllerToolOpts } from "./runtime/run-controller.js"

/* ---- Tool Runtime (Phase 2) ---- */
export { ToolCallValidator, ToolOutputTruncator, processToolCalls } from "./tools/tool-runtime.js"
export type { ArtifactMeta, ArtifactWriter, ValidationResult, TruncatedOutput, ToolCallProcessResult, ProcessToolCallsInput } from "./tools/tool-runtime.js"

/* ---- AssistantRuntime (Phase 3) ---- */
export { AssistantRuntime } from "./runtime/assistant-runtime.js"
export type {
  ConversationStore,
  ConversationStoreMessage,
  ContextBuilder,
  ToolValidationResult,
  ToolManager,
} from "./runtime/assistant-runtime.js"
export { AssistantRun } from "./runtime/assistant-run.js"
export type { AssistantRunStatus } from "./runtime/assistant-run.js"
export type { AssistantRuntimeEvent } from "./runtime/assistant-runtime-events.js"
export type {
  AssistantRuntimeError,
  AssistantRuntimeErrorCode,
} from "./runtime/runtime-errors.js"
export { AssistantRuntimeErrors } from "./runtime/runtime-errors.js"

/* ---- ContextManager (Phase 4) ---- */
export { ContextManager, DefaultContextManager } from "./context/context-manager.js"
export { estimateTokens, estimateMessageTokens } from "./context/token-budget.js"
export type {
  ArtifactEntry,
  ArtifactType,
  ContextManagerInput,
  ContextManagerOptions,
  ModelInput,
} from "./context/context-types.js"
export { DEFAULT_CONTEXT_OPTIONS } from "./context/context-types.js"

/* ---- Model Schema (Phase 1 — canonical types) ---- */
export type {
  ModelContentPart,
  ModelMessage,
} from "./model/model-message.js"
export type {
  ModelEvent,
  TokenUsage,
  ModelError,
} from "./model/model-event.js"
export { MODEL_ERROR_CODES } from "./model/model-event.js"
export type {
  CanonicalToolDefinition,
  CanonicalToolResult,
  InternalToolDefinition,
  ModelToolCall,
  ValidatedToolCall,
  ModelToolContext,
  ToolExecutionResult,
  JsonSchema,
} from "./model/model-tool.js"
export type {
  ProviderRuntime,
  ProviderRuntimeState,
  CanonicalCreateInput,
  CanonicalToolContinuationInput,
} from "./model/model-runtime.js"
export type {
  ProviderRuntimeRegistry,
  ProviderRuntimeFactory,
  ProviderRuntimeFactoryInput,
} from "./model/provider-runtime-registry.js"
export { DefaultProviderRuntimeRegistry } from "./model/provider-runtime-registry.js"

/* ---- Tool Schema Encoder (Phase 1) ---- */
export { encodeToolSchemas } from "./tools/tool-schema.js"
export type { ProviderToolSchema } from "./tools/tool-schema.js"

/* ---- Tool Result Limiter (Phase 1) ---- */
export { ToolResultLimiter } from "./tools/tool-result-limiter.js"
export type {
  LimitedOutput,
  ToolResultLimiterOptions,
} from "./tools/tool-result-limiter.js"
export { buildToolHistorySummary, isToolHistorySummary } from "./tools/tool-history-summary.js"
export type { BuildToolHistorySummaryInput } from "./tools/tool-history-summary.js"

/* ---- Doom Loop Detector (Phase 1) ---- */
export { DoomLoopDetector, buildDoomLoopErrorOutput } from "./tools/doom-loop-detector.js"
export type { DoomLoopResult } from "./tools/doom-loop-detector.js"

/* ---- TTS Integration (Phase 3) ---- */
export { sanitizeTextForTts, extractTtsInstruction, removeEmojiAndKaomoji, segmentLongText } from "./tts-text-sanitizer.js"
export { getTtsInstructionPrompt, isTtsInstructionInjected, TTS_INSTRUCTION_MARKER } from "./tts-instruction-prompt.js"
