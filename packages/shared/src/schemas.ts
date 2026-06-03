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

/** Artifact produced during tool execution (e.g. screenshot image) */
export interface ToolArtifact {
  id: string
  type: string
  data: unknown
  mimeType?: string
  /** If the artifact is stored on disk, the path reference */
  path?: string
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
