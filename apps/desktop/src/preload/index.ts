import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"

const api = {
  sendUserMessage: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.SEND_USER_MESSAGE, text),
  approveAction: (actionId: string) => ipcRenderer.invoke(IPC_CHANNELS.APPROVE_ACTION, actionId),
  denyAction: (actionId: string, reason?: string) => ipcRenderer.invoke(IPC_CHANNELS.DENY_ACTION, actionId, reason),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:update", patch),
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
