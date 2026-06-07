import type {
  ToolName,
  PermissionLevel,
  AgentMode,
  ToolArtifact,
  MultimodalContent,
  ArtifactRef,
  AudioContextAttachment,
  Emotion,
} from "@live2d-agent/shared"

/* ---- Re-export shared types that are part of the core domain ---- */
export type {
  ToolName,
  PermissionLevel,
  AgentMode,
  ToolArtifact,
  MultimodalContent,
  ArtifactRef,
  AudioContextAttachment,
  Emotion,
}

/* ---- Agent Message ---- */
export type EmotionSource = "llm-tag" | "fallback" | "disabled"

/**
 * Free-form metadata attached to an AgentMessage. The emotion field is the
 * only structured value defined today; the rest is left open so future
 * rendering layers (captions, logs, etc.) can hang their data off the message
 * without breaking the protocol.
 */
export interface AgentMessageMetadata {
  emotion?: Emotion
  emotionSource?: EmotionSource
  rawEmotionTag?: string
  parseWarning?: string
}

export interface AgentMessage {
  id: string
  role: "system" | "user" | "assistant" | "tool"
  content: string | MultimodalContent[]
  /** Tool calls proposed by the model (only on assistant messages) */
  actions?: AgentAction[]
  /** Links a tool-role observation back to the originating call */
  toolCallId?: string
  createdAt: number
  extra?: Record<string, unknown>
  /**
   * Structured per-message metadata. The emotion pipeline (see docs §10)
   * populates this on assistant messages; other roles leave it undefined.
   */
  metadata?: AgentMessageMetadata
  /**
   * Audio context attachments for this message (currently only used on
   * user messages). The actual audio bytes are NOT stored here — the
   * ModelAdapter reads the referenced artifact at request time and
   * converts it to a multimodal `input_audio` part.
   */
  attachments?: AudioContextAttachment[]
}

/* ---- Agent Action (tool invocation) ---- */
export interface AgentAction {
  id: string
  /** Provider-specific tool call id, e.g. OpenAI `call_xxx`. */
  providerToolCallId?: string
  tool: ToolName
  args: unknown
  source: "llm" | "user" | "system"
  createdAt: number
}

/* ---- Tool Execution Result ---- */
export interface ToolResult {
  actionId: string
  /** Provider-specific tool call id copied from the originating action. */
  providerToolCallId?: string
  tool: ToolName
  ok: boolean
  content: string
  data?: unknown
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
  artifacts?: ToolArtifact[]
  startedAt: number
  endedAt: number
}

/* ---- Tool Definition (exposed to the model) ---- */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  permission: PermissionLevel
}

/* ---- Agent Event (observable by renderer / Live2D) ---- */
export type AgentEvent =
  | { type: "agent.idle" }
  | { type: "agent.thinking" }
  | { type: "message.added"; message: AgentMessage }
  | {
      type: "message.created"
      message: {
        id: string
        role: "assistant" | "user"
        content?: string
        createdAt: number
      }
    }
  | { type: "message.delta"; messageId: string; delta: string }
  | { type: "message.completed"; messageId: string }
  | { type: "approval.pending"; actions: AgentAction[] }
  | { type: "approval.approved"; actionIds: string[] }
  | { type: "approval.denied"; actionIds: string[]; reason?: string }
  | { type: "tool.started"; action: AgentAction }
  | { type: "tool.finished"; result: ToolResult }
  | { type: "tool.error"; result: ToolResult }
  | { type: "agent.error"; error: string }
  | { type: "settings.updated"; settings?: unknown }
  | {
      type: "emotion.set"
      emotion: Emotion
      source: EmotionSource
      messageId: string
    }
  /* ---- Audio / voice input lifecycle (trace-only events) ---- */
  | { type: "audio.artifact.created"; artifact: import("@live2d-agent/shared").AudioArtifactRef }
  | { type: "audio.attachment.added"; attachment: import("@live2d-agent/shared").AudioContextAttachment }
  | { type: "audio.attachment.removed"; attachmentId: string }
  | {
      type: "audio.sent_to_model"
      attachmentId: string
      format: "wav" | "mp3"
      durationMs: number
      bytes: number
    }
  | { type: "audio.error"; code: string; message: string }
  | { type: "recording.started"; maxDurationMs: number; preferredFormat: "wav" | "mp3" }
  | { type: "recording.cancelled"; reason?: string }
  | { type: "recording.finished"; durationMs: number; mimeType: string; size: number }

/* ---- Callback & subscription types ---- */
export type AgentEventCallback = (event: AgentEvent) => void
export type Unsubscribe = () => void
