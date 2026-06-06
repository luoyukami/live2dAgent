/* ------------------------------------------------------------------ */
/*  Basic shared types — no external schema library (no zod)          */
/* ------------------------------------------------------------------ */

import type { Emotion, EmotionSettings, Live2DEmotionProfile } from "./emotion.js"

export type {
  Emotion,
  EmotionSettings,
  Live2DEmotionBinding,
  Live2DEmotionProfile,
} from "./emotion.js"
export {
  DEFAULT_EMOTION_SETTINGS,
  DEFAULT_LIVE2D_EMOTION_PROFILE,
  EMOTION_VALUES,
  isEmotion,
  resolveEmotionBinding,
} from "./emotion.js"

/** Agent mode controls permission enforcement strategy */
export type AgentMode = "manual" | "confirm" | "auto"

/** Tool permission mode controls how aggressively tools are auto-approved. */
export type ToolPermissionMode = "ask" | "permissive"

/** Permission levels map 1:1 to the v0 tool set */
export type PermissionLevel =
  | "safe"
  | "workspace_read"
  | "workspace_write"
  | "screen_read"
  | "clipboard_read"
  | "clipboard_write"
  | "shell"
  | "dangerous"

/** A tool name is a dot-separated string, e.g. "shell.run" */
export type ToolName = string

/** Kinds of artifacts stored by ArtifactStore */
export type ArtifactKind = "screenshot" | "tool-output" | "file-content" | "audio"

/** Audio MIME types the v0 voice input pipeline can produce or consume. */
export type AudioMimeType = "audio/wav" | "audio/mpeg" | "audio/webm"

/** Reference to a stored audio artifact on disk. */
export interface AudioArtifactRef extends ArtifactRef {
  kind: "audio"
  mimeType: AudioMimeType
  durationMs: number
}

/** Reference to a stored artifact on disk */
export interface ArtifactRef {
  id: string
  kind: ArtifactKind
  path: string
  mimeType: string
  size: number
  createdAt: number
}

/** Artifact produced during tool execution (e.g. screenshot image) */
export interface ToolArtifact {
  id: string
  type: string
  data?: unknown
  mimeType?: string
  /** If the artifact is stored on disk, the path reference */
  path?: string
  /** Structured reference to a disk-stored artifact */
  artifact?: ArtifactRef
}

/** Content block for multimodal messages */
export interface MultimodalContent {
  type: "text" | "image_url" | "input_audio"
  text?: string
  image_url?: {
    url: string
    detail?: "low" | "high" | "auto"
  }
  /**
   * Audio input content part. Only generated at request time by the
   * ModelAdapter — never stored in the AgentMessage on disk, never
   * persisted in trace files.
   */
  input_audio?: {
    data: string
    format: "wav" | "mp3"
  }
}

/**
 * Audio context attachment — created when the user finishes recording.
 * Lives on the user message; the ModelAdapter reads the referenced
 * artifact at request time and converts it to a multimodal `input_audio`
 * content part. The attachment object itself carries NO base64 data, so
 * traces / IPC payloads stay small.
 */
export interface AudioContextAttachment {
  id: string
  type: "audio"
  label: string
  artifact: AudioArtifactRef
  mimeType: AudioMimeType
  durationMs: number
  createdAt: number
}

/** Voice input settings. v0: master switch + audio-input switch + format + duration cap + push-to-talk hotkey. */
export interface VoiceInputSettings {
  /** Master switch. When false the recorder button is hidden and the hotkey is a no-op. */
  enabled: boolean
  /** When false the recorder still records but the model adapter will not inject `input_audio` parts. */
  audioInputEnabled: boolean
  /** Preferred audio format for model input. The recorder will pick the closest match the browser can produce. */
  preferredFormat: "wav" | "mp3"
  /** Hard cap on a single recording's duration, in milliseconds. */
  maxDurationMs: number
  /** Electron-style accelerator string. e.g. "CommandOrControl+Alt+V". */
  pushToTalkHotkey: string
}

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = {
  enabled: true,
  audioInputEnabled: true,
  preferredFormat: "wav",
  maxDurationMs: 30_000,
  pushToTalkHotkey: "CommandOrControl+Alt+V",
}

/** Default permission policy (v0) */
export const DEFAULT_PERMISSION_POLICY: Record<PermissionLevel, string> = {
  safe: "auto",
  workspace_read: "auto",
  workspace_write: "confirm_each",
  screen_read: "confirm_once_per_session",
  clipboard_read: "confirm_each",
  clipboard_write: "confirm_each",
  shell: "confirm_each",
  dangerous: "deny",
}

/* ------------------------------------------------------------------ */
/*  Settings types (Phase 1)                                          */
/* ------------------------------------------------------------------ */

/** Live2D avatar display settings */
export interface Live2DSettings {
  modelPath: string
  scale: number
  x: number
  y: number
  /**
   * Optional per-emotion binding profile. When set, this profile is used
   * INSTEAD of `DEFAULT_LIVE2D_EMOTION_PROFILE`. A user can hand-write a
   * `live2d.emotionProfile` block in `settings.json` to point each emotion
   * at the actual motion / expression names that their model ships with.
   */
  emotionProfile?: Live2DEmotionProfile
}

/** Window UI settings */
export interface UiSettings {
  alwaysOnTop: boolean
  opacity: number
}

/** Agent runtime settings */
export interface AgentSettings {
  maxSteps: number
}

/** Tool permission settings */
export interface PermissionSettings {
  mode: ToolPermissionMode
}

/** Full application settings (stored on disk, never sent to renderer as-is) */
export interface AppSettings {
  mode: AgentMode
  workspaceDir: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey?: string
  live2d: Live2DSettings
  ui: UiSettings
  agent: AgentSettings
  permissions: PermissionSettings
  emotion: EmotionSettings
  voice: VoiceInputSettings
}

/** Public-facing settings — API key replaced with a boolean flag */
export type PublicSettings = Omit<AppSettings, "openaiApiKey"> & { hasApiKey: boolean }

/** Partial patch for Live2D settings (allowed in public patch) */
export type Live2DSettingsPatch = Partial<{
  scale: number
  x: number
  y: number
  /** Full replacement for the emotion profile. Omit to leave unchanged. */
  emotionProfile: Live2DEmotionProfile
}>

/** Partial patch for UI settings (allowed in public patch) */
export type UiSettingsPatch = Partial<UiSettings>

/** Partial patch for agent settings (allowed in public patch) */
export type AgentSettingsPatch = Partial<AgentSettings>

/** Partial patch for emotion settings (allowed in public patch) */
export type EmotionSettingsPatch = Partial<EmotionSettings>

/** Partial patch for voice input settings (allowed in public patch) */
export type VoiceInputSettingsPatch = Partial<VoiceInputSettings>

/** Patch payload allowed through updatePublicPatch — no API key or workspace */
export interface AppSettingsPublicPatch {
  mode?: AgentMode
  openaiBaseUrl?: string
  openaiModel?: string
  live2d?: Live2DSettingsPatch
  ui?: UiSettingsPatch
  agent?: AgentSettingsPatch
  permissions?: Partial<PermissionSettings>
  emotion?: EmotionSettingsPatch
  voice?: VoiceInputSettingsPatch
}

/* ------------------------------------------------------------------ */
/*  Debug Snapshot (used by renderer debug panel)                     */
/* ------------------------------------------------------------------ */

/** Lightweight summary of the latest parsed emotion, used by Debug Panel. */
export interface DebugEmotionInfo {
  enabled: boolean
  injectPrompt: boolean
  defaultEmotion: Emotion
  /** Last emotion that was applied to the Live2D / renderer side. */
  lastEmotion: Emotion
  /** Source of the last emotion (llm-tag / fallback / disabled). */
  lastSource: "llm-tag" | "fallback" | "disabled"
  /** Raw tag text parsed from the assistant message (if any). */
  lastRawTag?: string
  /** Parser warning from the last assistant message (if any). */
  lastParseWarning?: string
  /** True when the system prompt currently contains the emotion tag section. */
  promptInjected: boolean
}

export interface DebugSnapshot {
  settings: PublicSettings
  session: {
    tracePath: string
    stepCount?: number
    avatarState?: string
  }
  recentEvents: Array<{ ts: number; event: unknown }>
  lastModelRequest?: unknown
  lastModelResponse?: unknown
  lastToolCall?: unknown
  lastPermissionDecision?: unknown
  lastToolResult?: unknown
  /**
   * The prompt that will actually be sent to the model — i.e. the raw
   * user-editable prompt with the emotion block appended (when enabled).
   * This is what the chat header and debug panel should display.
   */
  systemPromptPreview?: string
  /** Optional preview of the raw user-editable system prompt (no emotion block). */
  rawSystemPromptPreview?: string
  promptError?: string
  emotion?: DebugEmotionInfo

  /** Convenience aliases used by the renderer Debug Panel. */
  model: string
  baseURL: string
  workspace: string
  mode: AgentMode
  permissionMode: ToolPermissionMode
  maxSteps: number
  avatarState: string
  tracePath: string
  lastPermission?: unknown

  /* ---- Voice input (v0 voice feature) ---- */
  voice?: DebugVoiceInfo
}

/**
 * Lightweight voice-input summary used by the Debug Panel.
 * `lastAudioArtifact` / `lastAudioAttachment` are references (path + id),
 * not the raw bytes. The Debug Panel must NEVER show base64.
 */
export interface DebugVoiceInfo {
  enabled: boolean
  audioInputEnabled: boolean
  preferredFormat: "wav" | "mp3"
  maxDurationMs: number
  hotkey: string
  /** Status of the most recent recording attempt. */
  lastRecordingState: "idle" | "recording" | "finished" | "cancelled" | "error"
  /** Reference to the most recently created audio artifact (if any). */
  lastAudioArtifact?: {
    id: string
    path: string
    mimeType: string
    size: number
    durationMs: number
    createdAt: number
  }
  /** Format that was actually sent to the model on the most recent send. */
  lastSentFormat?: "wav" | "mp3"
  /** Most recent audio error message (if any). */
  lastError?: string
}
