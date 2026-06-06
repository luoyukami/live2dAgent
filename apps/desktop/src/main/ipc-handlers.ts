import { ipcMain, shell } from "electron"
import { IPC_CHANNELS, type AudioContextAttachment, type AudioMimeType, type AudioArtifactRef, type DebugSnapshot } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
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

/**
 * Runtime-validate a renderer-reported audio lifecycle event. Only the
 * allowlisted types pass through, and each must carry the correct payload
 * shape. Returns `null` for any invalid / disallowed event.
 */
function validateAudioLifecycleEvent(event: unknown): AgentEvent | null {
  if (!event || typeof event !== "object") return null
  const e = event as Record<string, unknown>
  const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0
  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  switch (e.type) {
    case "recording.started":
      return isNumber(e.maxDurationMs) && (e.preferredFormat === "wav" || e.preferredFormat === "mp3")
        ? (event as AgentEvent)
        : null
    case "recording.cancelled":
      return event as AgentEvent
    case "recording.finished":
      return isNumber(e.durationMs) && isString(e.mimeType) && isNumber(e.size)
        ? (event as AgentEvent)
        : null
    case "audio.attachment.added":
      return e.attachment && typeof e.attachment === "object"
        ? (event as AgentEvent)
        : null
    case "audio.attachment.removed":
      return isString(e.attachmentId) ? (event as AgentEvent) : null
    case "audio.error":
      return isString(e.code) && typeof e.message === "string"
        ? (event as AgentEvent)
        : null
    default:
      return null
  }
}

export function registerIpcHandlers(services: IpcServices): void {
  /* ---- Agent messaging ---- */
  ipcMain.handle(IPC_CHANNELS.SEND_USER_MESSAGE, async (_event, textOrInput: string | { text: string; attachments?: AudioContextAttachment[] }) => {
    await services.agent.sendUserMessage(textOrInput)
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
      voice: debug.voice,

      model: settings.openaiModel,
      reasoningEffort: settings.reasoningEffort,
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

  /**
   * Generic "renderer pushed a trace event" channel. The renderer uses this
   * to record audio / recording lifecycle events (recording.started, etc.)
   * that originate in the renderer process. The main process forwards the
   * event to the TraceService AND to the EventBus so the renderer sees it
   * immediately via the agent event channel too.
   *
   * SECURITY: only the small set of audio / recording event types is allowed.
   * This prevents a malicious renderer from spuriously marking tool results
   * as finished, etc.
   */
  ipcMain.handle(IPC_CHANNELS.TRACE_APPEND, async (_event, event: unknown) => {
    const validated = validateAudioLifecycleEvent(event)
    if (!validated) return
    services.agent.emitEvent(validated)
  })

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

  /* ---- Audio (voice input) ---- */

  const KNOWN_AUDIO_MIME_TYPES = new Set<string>(["audio/wav", "audio/mpeg", "audio/webm"])

  function mimeToExt(mimeType: string): string {
    switch (mimeType as AudioMimeType) {
      case "audio/wav": return ".wav"
      case "audio/mpeg": return ".mp3"
      case "audio/webm": return ".webm"
      default: return ".bin"
    }
  }

  ipcMain.handle(IPC_CHANNELS.AUDIO_SAVE_RECORDING, async (_event, request: { data: ArrayBuffer; mimeType: string; durationMs?: number }) => {
    try {
      const { data, mimeType, durationMs } = request
      if (!data || !(data instanceof ArrayBuffer) || data.byteLength === 0) {
        const error = { code: "AUDIO_EMPTY_DATA", message: "Recording data is empty" }
        services.trace.append({ type: "audio.error", ...error })
        return { ok: false, error }
      }
      if (!mimeType || typeof mimeType !== "string" || !KNOWN_AUDIO_MIME_TYPES.has(mimeType)) {
        const error = { code: "AUDIO_UNSUPPORTED_MIME", message: `Unsupported MIME type: ${String(mimeType)}` }
        services.trace.append({ type: "audio.error", ...error })
        return { ok: false, error }
      }

      const ref = services.artifacts.saveArtifact({
        kind: "audio",
        mimeType,
        data: Buffer.from(data),
        ext: mimeToExt(mimeType),
      })

      const audioRef: AudioArtifactRef = {
        id: ref.id,
        kind: "audio",
        path: ref.path,
        mimeType: mimeType as AudioMimeType,
        size: ref.size,
        durationMs: durationMs ?? 0,
        createdAt: ref.createdAt,
      }

      const attachment: AudioContextAttachment = {
        id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type: "audio",
        label: "录音",
        artifact: audioRef,
        mimeType: mimeType as AudioMimeType,
        durationMs: durationMs ?? 0,
        createdAt: Date.now(),
      }

      services.agent.setVoiceDebug({
        lastRecordingState: "finished",
        lastAudioArtifact: {
          id: ref.id,
          path: ref.path,
          mimeType: ref.mimeType,
          size: ref.size,
          durationMs: durationMs ?? 0,
          createdAt: ref.createdAt,
        },
      })

      // Trace event
      services.trace.append({ type: "audio.artifact.created", artifact: audioRef })

      return { ok: true, attachment }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const error = { code: "AUDIO_SAVE_FAILED", message }
      services.trace.append({ type: "audio.error", ...error })
      return { ok: false, error }
    }
  })

  ipcMain.handle(IPC_CHANNELS.AUDIO_OPEN_FOLDER, async () => {
    const audioDir = services.artifacts.getBaseDir() + "/audio"
    await shell.openPath(audioDir)
  })

  /**
   * NOTE: Debug state pushed by the renderer is UI-reported telemetry, NOT the
   * source of truth. Real artifact creation is tracked in the main process
   * via AUDIO_SAVE_RECORDING. The Debug Panel must surface this distinction.
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_DEBUG_UPDATE, async (_event, input: Partial<{
    lastRecordingState: "idle" | "recording" | "finished" | "cancelled" | "error"
    lastAudioArtifact: { id: string; path: string; mimeType: string; size: number; durationMs: number; createdAt: number }
    lastSentFormat: "wav" | "mp3"
    lastError: string
  }>) => {
    services.agent.setVoiceDebug(input)
  })
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function truncatePreview(value: string, max = 2400): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}
