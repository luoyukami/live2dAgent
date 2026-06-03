import type { ToolName, AgentMode } from "./schemas.js"

/* ------------------------------------------------------------------ */
/*  IPC request / response payload types                              */
/*  These are used by both the preload bridge and main-process        */
/*  handlers to ensure type safety across the IPC boundary.           */
/* ------------------------------------------------------------------ */

export interface IpcSendUserMessageRequest {
  text: string
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
