import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentService } from "./services/agent-service.js"
import type { PermissionService } from "./services/permission-service.js"
import type { SettingsService } from "./services/settings-service.js"

export interface IpcServices {
  agent: AgentService
  permissions: PermissionService
  settings: SettingsService
}

export function registerIpcHandlers(services: IpcServices): void {
  ipcMain.handle(IPC_CHANNELS.SEND_USER_MESSAGE, async (_event, text: string) => {
    await services.agent.sendUserMessage(text)
  })

  ipcMain.handle(IPC_CHANNELS.APPROVE_ACTION, async (_event, actionId: string) => {
    services.permissions.approve(actionId)
  })

  ipcMain.handle(
    IPC_CHANNELS.DENY_ACTION,
    async (_event, actionId: string, reason?: string) => {
      services.permissions.deny(actionId, reason)
    },
  )

  ipcMain.handle(IPC_CHANNELS.SET_AGENT_MODE, async (_event, mode) => {
    services.settings.updatePublicPatch({ mode })
  })

  ipcMain.handle("settings:get", async () => services.settings.getPublicSettings())
  ipcMain.handle("settings:update", async (_event, patch) => {
    services.settings.updatePublicPatch(patch)
    services.agent.reconfigure()
  })
}
