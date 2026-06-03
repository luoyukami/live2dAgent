import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type { PublicSettings, AppSettingsPublicPatch } from "@live2d-agent/shared"

const api = {
  /* ---- Agent ---- */
  sendUserMessage: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.SEND_USER_MESSAGE, text),
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

  /* ---- Agent events ---- */
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.ON_AGENT_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ON_AGENT_EVENT, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld("petAgent", api)

export type PetAgentApi = typeof api
