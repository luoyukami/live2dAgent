import { ipcMain, shell } from "electron"
import { IPC_CHANNELS, type DebugSnapshot } from "@live2d-agent/shared"
import type { AgentService } from "./services/agent-service.js"
import type { ArtifactStore } from "./services/artifact-store.js"
import type { PermissionService } from "./services/permission-service.js"
import type { PromptService } from "./services/prompt-service.js"
import type { SettingsService } from "./services/settings-service.js"
import type { TraceService } from "./services/trace-service.js"

export interface IpcServices {
  agent: AgentService
  permissions: PermissionService
  settings: SettingsService
  trace: TraceService
  artifacts: ArtifactStore
  prompts: PromptService
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
    services.trace.append({ type: "settings.updated", settings: services.settings.getPublicSettings() })
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
    services.trace.append({ type: "settings.updated", settings: services.settings.getPublicSettings() })
  })

  /** Update API key (stays in main process) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_API_KEY, async (_event, apiKey: string) => {
    services.settings.updateApiKey(apiKey)
    services.agent.reconfigure()
    services.trace.append({ type: "settings.updated", settings: services.settings.getPublicSettings() })
  })

  /** Update workspace directory (creates if missing) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_WORKSPACE, async (_event, path: string) => {
    services.settings.updateWorkspaceDir(path)
    services.agent.reconfigure()
    services.trace.append({ type: "settings.updated", settings: services.settings.getPublicSettings() })
  })

  /** Update live2d model path */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_LIVE2D_MODEL_PATH, async (_event, modelPath: string) => {
    services.settings.updateLive2DModelPath(modelPath)
    services.trace.append({ type: "settings.updated", settings: services.settings.getPublicSettings() })
  })

  /* ---- Debug / Trace / Prompt / Manual Action (v0.2) ---- */
  ipcMain.handle(IPC_CHANNELS.DEBUG_GET_SNAPSHOT, async (): Promise<DebugSnapshot> => {
    const settings = services.settings.getPublicSettings()
    const debug = services.agent.getDebugState()
    return {
      settings,
      session: {
        tracePath: services.trace.getSessionFile(),
        stepCount: debug.stepCount,
        avatarState: debug.avatarState,
      },
      recentEvents: services.trace.getRecentEvents(50),
      lastModelRequest: debug.lastModelRequest,
      lastModelResponse: debug.lastModelResponse,
      lastToolCall: debug.lastToolCall,
      lastPermissionDecision: services.permissions.getLastDecision(),
      lastToolResult: debug.lastToolResult,
      // `systemPromptPreview` shows the prompt that will actually be sent
      // to the model, so the debug panel reflects what the LLM sees. The raw
      // user-editable prompt is exposed separately.
      systemPromptPreview: truncatePreview(debug.composedSystemPrompt),
      rawSystemPromptPreview: truncatePreview(debug.rawSystemPrompt),
      promptError: services.prompts.getError(),
      emotion: debug.emotion,

      model: settings.openaiModel,
      baseURL: settings.openaiBaseUrl,
      workspace: settings.workspaceDir,
      mode: settings.mode,
      permissionMode: settings.permissions.mode,
      maxSteps: settings.agent.maxSteps,
      avatarState: debug.avatarState,
      tracePath: services.trace.getSessionFile(),
      lastPermission: services.permissions.getLastDecision(),
    }
  })

  ipcMain.handle(IPC_CHANNELS.TRACE_GET_EVENTS, async () => services.trace.readCurrentEvents())
  ipcMain.handle(IPC_CHANNELS.TRACE_OPEN_FOLDER, async () => { await shell.openPath(services.trace.getTracesDir()) })
  ipcMain.handle(IPC_CHANNELS.ARTIFACT_OPEN_FOLDER, async () => { await shell.openPath(services.artifacts.getBaseDir()) })
  ipcMain.handle(IPC_CHANNELS.PROMPT_OPEN_FOLDER, async () => { await shell.openPath(services.prompts.getDir()) })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_RELOAD, async () => {
    const publicSettings = services.settings.reload()
    services.agent.reconfigure()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    return publicSettings
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_RELOAD, async () => {
    services.prompts.reload()
    services.agent.reconfigure()
  })

  ipcMain.handle(IPC_CHANNELS.LIVE2D_RELOAD, async () => undefined)

  ipcMain.handle(IPC_CHANNELS.MANUAL_ACTION_RUN, async (_event, tool: string, args: unknown) => {
    await services.agent.runManualAction(tool, args)
  })
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function truncatePreview(value: string, max = 2400): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}
