import type { ToolName, AgentMode, AudioContextAttachment } from "./schemas.js"

/* ------------------------------------------------------------------ */
/*  IPC request / response payload types                              */
/*  These are used by both the preload bridge and main-process        */
/*  handlers to ensure type safety across the IPC boundary.           */
/* ------------------------------------------------------------------ */

export interface IpcSendUserMessageRequest {
  text: string
  /**
   * Audio / screenshot / etc. context attachments to forward to the
   * AgentSession alongside the user text. Only references are passed —
   * the heavy bytes (audio, image) are read from the artifact store
   * by the main process / model adapter on demand.
   */
  attachments?: AudioContextAttachment[]
}

export interface IpcSaveAudioRecordingRequest {
  /**
   * The recorded audio bytes. The main process decides whether to
   * transcode to the preferred format (e.g. webm -> wav) before
   * persisting as an artifact.
   */
  data: ArrayBuffer
  /**
   * MIME type the renderer claims the bytes are in. The main process
   * uses this to decide whether transcoding is needed.
   */
  mimeType: string
  /**
   * Optional pre-measured duration. When omitted the main process
   * estimates it from the WAV header (if applicable) or falls back
   * to 0.
   */
  durationMs?: number
  /** Preferred output format. Defaults to settings.voice.preferredFormat. */
  preferredFormat?: "wav" | "mp3"
}

export interface IpcSaveAudioRecordingResponse {
  ok: boolean
  attachment?: import("./schemas.js").AudioContextAttachment
  error?: {
    code: string
    message: string
  }
}

export interface IpcApproveActionRequest {
  actionId: string
}

export interface IpcDenyActionRequest {
  actionId: string
  reason?: string
}

export interface IpcSetAgentModeRequest {
  mode: AgentMode
}

/** Generic payload for tool-execution IPC calls */
export interface IpcToolRequest {
  actionId: string
  tool: ToolName
  args: unknown
}

export interface IpcToolResponse {
  ok: boolean
  content: string
  data?: unknown
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
}
