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
