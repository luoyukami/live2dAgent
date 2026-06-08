import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type { PublicSettings, AppSettingsPublicPatch, DebugSnapshot, IpcSaveAudioRecordingRequest, IpcSaveAudioRecordingResponse, IpcSendUserMessageRequest, CompactInputAnchor } from "@live2d-agent/shared"

const api = {
  /* ---- Agent ---- */
  sendUserMessage: (input: string | IpcSendUserMessageRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEND_USER_MESSAGE, input),
  clearContext: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_CONTEXT),
  approveAction: (actionId: string) => ipcRenderer.invoke(IPC_CHANNELS.APPROVE_ACTION, actionId),
  denyAction: (actionId: string, reason?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DENY_ACTION, actionId, reason),

  /* ---- Settings (Phase 1) ---- */
  getSettings: (): Promise<PublicSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  updatePublicSettings: (patch: AppSettingsPublicPatch): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_PUBLIC, patch),
  updateApiKey: (apiKey: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_API_KEY, apiKey),
  updateWorkspaceDir: (path: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_WORKSPACE, path),
  updateLive2DModelPath: (modelPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_LIVE2D_MODEL_PATH, modelPath),
  moveWindowBy: (dx: number, dy: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MOVE_BY, dx, dy),
  startWindowDrag: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_DRAG_START),
  endWindowDrag: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_DRAG_END),
  setMousePassthrough: (enabled: boolean, windowType?: "combined" | "avatar"): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_MOUSE_PASSTHROUGH, enabled, windowType),

  /* ---- Dual-window UI control ---- */
  showCompactInput: (anchor?: CompactInputAnchor): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SHOW_COMPACT_INPUT, anchor),
  showDetailPanel: (tab?: "chat" | "settings" | "debug"): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SHOW_DETAIL_PANEL, tab),
  hideUiWindow: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_HIDE_UI),
  onUiCommand: (listener: (payload: { mode: "hidden" | "compact" | "detail"; tab?: "chat" | "settings" | "debug" }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { mode: "hidden" | "compact" | "detail"; tab?: "chat" | "settings" | "debug" }) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.WINDOW_UI_COMMAND, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_UI_COMMAND, wrapped)
    }
  },

  /* ---- Agent events ---- */
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.ON_AGENT_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ON_AGENT_EVENT, wrapped)
    }
  },

  /* ---- Settings broadcast (Phase 5) ---- */
  onSettingsUpdated: (listener: (settings: PublicSettings) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: PublicSettings) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_UPDATED, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_UPDATED, wrapped)
    }
  },

  /* ---- Live2D reload broadcast ---- */
  onLive2DReloaded: (listener: () => void) => {
    const wrapped = () => listener()
    ipcRenderer.on(IPC_CHANNELS.LIVE2D_RELOADED, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.LIVE2D_RELOADED, wrapped)
    }
  },

  /* ---- Debug / Trace / Manual Action (Phase 2) ---- */
  getDebugSnapshot: (): Promise<DebugSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.DEBUG_GET_SNAPSHOT),
  getTraceEvents: (): Promise<Array<{ ts: number; event: AgentEvent }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRACE_GET_EVENTS),
  appendTraceEvent: (event: AgentEvent): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRACE_APPEND, event),
  openTraceFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRACE_OPEN_FOLDER),
  openArtifactFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_OPEN_FOLDER),
  openPromptFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROMPT_OPEN_FOLDER),
  reloadSettings: (): Promise<PublicSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RELOAD),
  reloadPrompt: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROMPT_RELOAD),
  reloadLive2D: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIVE2D_RELOAD),
  runManualAction: (tool: string, args: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MANUAL_ACTION_RUN, tool, args),

  /* ---- Audio (voice input) ---- */
  saveAudioRecording: (request: IpcSaveAudioRecordingRequest): Promise<IpcSaveAudioRecordingResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SAVE_RECORDING, request),
  openAudioFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIO_OPEN_FOLDER),
  updateVoiceDebug: (input: Partial<{
    lastRecordingState: "idle" | "recording" | "finished" | "cancelled" | "error"
    lastAudioArtifact: { id: string; path: string; mimeType: string; size: number; durationMs: number; createdAt: number }
    lastSentFormat: "wav" | "mp3"
    lastError: string
  }>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.VOICE_DEBUG_UPDATE, input),
}

contextBridge.exposeInMainWorld("petAgent", api)

export type PetAgentApi = typeof api
