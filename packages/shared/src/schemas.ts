/* ------------------------------------------------------------------ */
/*  Basic shared types — no external schema library (no zod)          */
/* ------------------------------------------------------------------ */

/** Agent mode controls permission enforcement strategy */
export type AgentMode = "manual" | "confirm" | "auto"

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
export type ArtifactKind = "screenshot" | "tool-output" | "file-content"

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
  type: "text" | "image_url"
  text?: string
  image_url?: {
    url: string
    detail?: "low" | "high" | "auto"
  }
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
}

/** Public-facing settings — API key replaced with a boolean flag */
export type PublicSettings = Omit<AppSettings, "openaiApiKey"> & { hasApiKey: boolean }

/** Partial patch for Live2D settings (allowed in public patch) */
export type Live2DSettingsPatch = Partial<Live2DSettings>

/** Partial patch for UI settings (allowed in public patch) */
export type UiSettingsPatch = Partial<UiSettings>

/** Partial patch for agent settings (allowed in public patch) */
export type AgentSettingsPatch = Partial<AgentSettings>

/** Patch payload allowed through updatePublicPatch — no API key or workspace */
export interface AppSettingsPublicPatch {
  mode?: AgentMode
  openaiBaseUrl?: string
  openaiModel?: string
  live2d?: Live2DSettingsPatch
  ui?: UiSettingsPatch
  agent?: AgentSettingsPatch
}
