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
  /* ---- Agent messaging ---- */
  ipcMain.handle(IPC_CHANNELS.SEND_USER_MESSAGE, async (_event, text: string) => {
    await services.agent.sendUserMessage(text)
  })

  /* ---- Permission actions ---- */
  ipcMain.handle(IPC_CHANNELS.APPROVE_ACTION, async (_event, actionId: string) => {
    services.permissions.approve(actionId)
  })

  ipcMain.handle(
    IPC_CHANNELS.DENY_ACTION,
    async (_event, actionId: string, reason?: string) => {
      services.permissions.deny(actionId, reason)
    },
  )

  /* ---- Agent mode (legacy compat, uses public-patch internally) ---- */
  ipcMain.handle(IPC_CHANNELS.SET_AGENT_MODE, async (_event, mode) => {
    services.settings.updatePublicPatch({ mode })
    services.agent.reconfigure()
  })

  /* ---- Settings (Phase 1) ---- */

  /** Get public-safe settings (no apiKey, only hasApiKey boolean) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return services.settings.getPublicSettings()
  })

  /** Update low-risk public settings fields */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_PUBLIC, async (_event, patch) => {
    services.settings.updatePublicPatch(patch)
    services.agent.reconfigure()
  })

  /** Update API key (stays in main process) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_API_KEY, async (_event, apiKey: string) => {
    services.settings.updateApiKey(apiKey)
    services.agent.reconfigure()
  })

  /** Update workspace directory (creates if missing) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_WORKSPACE, async (_event, path: string) => {
    services.settings.updateWorkspaceDir(path)
    services.agent.reconfigure()
  })

  /** Update live2d model path */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_LIVE2D_MODEL_PATH, async (_event, modelPath: string) => {
    services.settings.updateLive2DModelPath(modelPath)
  })
}
