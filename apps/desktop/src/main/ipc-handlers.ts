import { ipcMain, shell, dialog } from "electron"
import { mkdirSync } from "node:fs"
import { IPC_CHANNELS, type AudioContextAttachment, type AudioMimeType, type AudioArtifactRef, type ImageContextAttachment, type CompactInputAnchor, type DebugSnapshot, type AvatarHitRegionRect, type IpcTestModelConnectionRequest, type IpcTestModelConnectionResponse, type IpcTtsGenerateRequest, type IpcTtsRegisterVoiceRequest, type LocalTtsSettings } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type { AgentService } from "./services/agent-service.js"
import type { ArtifactStore } from "./services/artifact-store.js"
import type { PermissionService } from "./services/permission-service.js"
import type { PromptService } from "./services/prompt-service.js"
import type { SettingsService } from "./services/settings-service.js"
import type { TraceService } from "./services/trace-service.js"
import type { TtsService } from "./services/tts/tts-service.js"
import type { McpService } from "./services/mcp-service.js"
import type { WindowManager } from "./window-manager.js"

export interface IpcServices {
  agent: AgentService
  permissions: PermissionService
  settings: SettingsService
  trace: TraceService
  artifacts: ArtifactStore
  prompts: PromptService
  window: WindowManager
  tts: TtsService
  mcp?: McpService
}

async function reconfigureAgentServices(services: IpcServices): Promise<void> {
  await services.mcp?.reconfigure()
  services.agent.reconfigure()
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("Base URL 不能为空")
  return `${trimmed}/models`
}

async function testModelConnection(input: IpcTestModelConnectionRequest): Promise<IpcTestModelConnectionResponse> {
  try {
    const url = buildModelsUrl(input.baseUrl)
    const headers: Record<string, string> = { Accept: "application/json" }
    if (input.apiKey?.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`

    const response = await fetch(url, { method: "GET", headers })
    if (!response.ok) {
      return { ok: false, models: [], error: `连接失败：HTTP ${response.status}` }
    }
    const body = await response.json() as unknown
    const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : undefined
    if (!Array.isArray(data)) {
      return { ok: false, models: [], error: "响应中没有模型列表 data[]" }
    }
    const models = Array.from(new Set(data
      .map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())))
    return { ok: models.length > 0, models, error: models.length > 0 ? undefined : "模型列表为空" }
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
  }
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

  ipcMain.handle(IPC_CHANNELS.RETRY_LAST_USER_MESSAGE, async () => {
    await services.agent.retryLastUserMessage()
  })

  ipcMain.handle(IPC_CHANNELS.CLEAR_CONTEXT, async () => {
    services.agent.clearActiveContext()
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_ACTIVITY, async (_event, input?: { source?: "user" | "tts" | "voice"; active?: boolean }) => {
    const source = input?.source === "tts" || input?.source === "voice" ? input.source : "user"
    services.agent.noteCompanionActivity(source, typeof input?.active === "boolean" ? input.active : undefined)
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
    await reconfigureAgentServices(services)
    const publicSettings = services.settings.getPublicSettings()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
  })

  /* ---- Settings (Phase 1) ---- */

  /** Get public-safe settings (no apiKey, only hasApiKey boolean) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return services.settings.getPublicSettings()
  })

  /** Update low-risk public settings fields */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_PUBLIC, async (_event, patch) => {
    services.settings.updatePublicPatch(patch)
    const ui = services.settings.get().ui
    if (patch?.ui && ("width" in patch.ui || "height" in patch.ui)) {
      services.window.setSize(ui.width, ui.height)
    }
    if (patch?.ui && ("panelWidth" in patch.ui || "panelHeight" in patch.ui)) {
      services.window.setPanelDimensions(ui.panelWidth, ui.panelHeight)
    }
    await reconfigureAgentServices(services)
    const publicSettings = services.settings.getPublicSettings()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_DRAG_START, async (_event, windowType?: "avatar") => {
    services.window.startDrag(windowType)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_DRAG_END, async (_event, _windowType?: "avatar") => {
    services.window.endDrag()
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_MOUSE_PASSTHROUGH, async (_event, enabled: boolean, windowType?: "avatar") => {
    services.window.setMousePassthrough(Boolean(enabled), windowType)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_AVATAR_HIT_REGION, async (_event, rects: AvatarHitRegionRect[]) => {
    services.window.setAvatarHitRegion(rects)
  })

  /* ---- Dual-window UI control ---- */
  ipcMain.handle(IPC_CHANNELS.WINDOW_SHOW_COMPACT_INPUT, async (_event, anchor?: CompactInputAnchor) => {
    services.window.showCompactInput(anchor)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_SHOW_DETAIL_PANEL, async (_event, tab?: "chat" | "settings" | "debug") => {
    services.window.showDetailPanel(tab)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_HIDE_UI, async () => {
    services.window.hideUiWindow()
  })

  /** Update API key (stays in main process) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_API_KEY, async (_event, apiKey: string) => {
    services.settings.updateApiKey(apiKey)
    await reconfigureAgentServices(services)
    const publicSettings = services.settings.getPublicSettings()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_TEST_MODEL_CONNECTION, async (_event, input: IpcTestModelConnectionRequest): Promise<IpcTestModelConnectionResponse> => {
    return testModelConnection({
      ...input,
      apiKey: input.apiKey?.trim() || services.settings.get().openaiApiKey,
    })
  })

  /** Update workspace directory (creates if missing) */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_WORKSPACE, async (_event, path: string) => {
    services.settings.updateWorkspaceDir(path)
    await reconfigureAgentServices(services)
    const publicSettings = services.settings.getPublicSettings()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
  })

  /** Update live2d model path */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE_LIVE2D_MODEL_PATH, async (_event, modelPath: string) => {
    services.settings.updateLive2DModelPath(modelPath)
    const publicSettings = services.settings.getPublicSettings()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
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
      tts: debug.tts,
      mcp: services.mcp?.getDebugState(),

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
  ipcMain.handle(IPC_CHANNELS.MEMORY_OPEN_FOLDER, async () => {
    const memoryDir = services.settings.getMemoryDir()
    mkdirSync(memoryDir, { recursive: true })
    await shell.openPath(memoryDir)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_RELOAD, async () => {
    const publicSettings = services.settings.reload()
    await reconfigureAgentServices(services)
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
    return publicSettings
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_RELOAD, async () => {
    services.prompts.reload()
    await reconfigureAgentServices(services)
  })

  ipcMain.handle(IPC_CHANNELS.LIVE2D_RELOAD, async () => {
    services.window.broadcastLive2DReloaded()
  })

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

  /* ---- Image (user upload) ---- */

  const KNOWN_IMAGE_MIME_TYPES = new Set<string>(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])

  function imageMimeToExt(mimeType: string): string {
    switch (mimeType) {
      case "image/png": return ".png"
      case "image/jpeg":
      case "image/jpg": return ".jpg"
      case "image/webp": return ".webp"
      case "image/gif": return ".gif"
      default: return ".bin"
    }
  }

  ipcMain.handle(IPC_CHANNELS.IMAGE_SAVE, async (_event, request: { data: ArrayBuffer; mimeType: string; fileName?: string }) => {
    try {
      const { data, mimeType, fileName } = request
      if (!data || !(data instanceof ArrayBuffer) || data.byteLength === 0) {
        const error = { code: "IMAGE_EMPTY_DATA", message: "Image data is empty" }
        services.trace.append({ type: "image.error", code: error.code, message: error.message })
        return { ok: false, error }
      }
      if (!mimeType || typeof mimeType !== "string" || !KNOWN_IMAGE_MIME_TYPES.has(mimeType)) {
        const error = { code: "IMAGE_UNSUPPORTED_MIME", message: `Unsupported MIME type: ${String(mimeType)}` }
        services.trace.append({ type: "image.error", code: error.code, message: error.message })
        return { ok: false, error }
      }

      const ref = services.artifacts.saveArtifact({
        kind: "image",
        mimeType,
        data: Buffer.from(data),
        ext: imageMimeToExt(mimeType),
      })

      const imageRef: import("@live2d-agent/shared").ImageArtifactRef = {
        id: ref.id,
        kind: "image",
        path: ref.path,
        mimeType,
        size: ref.size,
        createdAt: ref.createdAt,
      }

      const attachment: ImageContextAttachment = {
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type: "image",
        label: fileName || `image${imageMimeToExt(mimeType)}`,
        artifact: imageRef,
        mimeType,
        createdAt: Date.now(),
      }

      services.trace.append({ type: "image.artifact.created", artifact: imageRef })

      return { ok: true, attachment }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const error = { code: "IMAGE_SAVE_FAILED", message }
      services.trace.append({ type: "image.error", code: error.code, message: error.message })
      return { ok: false, error }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ARTIFACT_READ, async (_event, request: { id: string; path: string }) => {
    try {
      const { path: artifactPath } = request
      if (!artifactPath || typeof artifactPath !== "string") {
        return { ok: false, error: { code: "ARTIFACT_INVALID_PATH", message: "Invalid artifact path" } }
      }
      const ref = { id: request.id, kind: "image" as const, path: artifactPath, mimeType: "application/octet-stream", size: 0, createdAt: 0 }
      const buffer = services.artifacts.readArtifact(ref)
      return { ok: true, data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: "ARTIFACT_READ_FAILED", message } }
    }
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
    if (input.lastRecordingState === "recording") {
      services.agent.noteCompanionActivity("voice", true)
    } else if (input.lastRecordingState === "idle" || input.lastRecordingState === "finished" || input.lastRecordingState === "cancelled" || input.lastRecordingState === "error") {
      services.agent.noteCompanionActivity("voice", false)
    }
  })

  /* ---- TTS (Phase 1) ---- */

  ipcMain.handle(IPC_CHANNELS.TTS_HEALTH_CHECK, async () => {
    return services.tts.healthCheck()
  })

  ipcMain.handle(IPC_CHANNELS.TTS_LIST_VOICES, async () => {
    return services.tts.listVoices()
  })

  ipcMain.handle(IPC_CHANNELS.TTS_REGISTER_VOICE, async (_event, req: IpcTtsRegisterVoiceRequest) => {
    return services.tts.registerVoice(req)
  })

  ipcMain.handle(IPC_CHANNELS.TTS_RENAME_VOICE, async (_event, voiceId: string, newVoiceId: string, overwrite?: boolean) => {
    return services.tts.renameVoice(voiceId, newVoiceId, overwrite)
  })

  ipcMain.handle(IPC_CHANNELS.TTS_SELECT_PROMPT_WAV, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg", "webm"] },
      ],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.TTS_DELETE_VOICE, async (_event, voiceId: string) => {
    return services.tts.deleteVoice(voiceId)
  })

  ipcMain.handle(IPC_CHANNELS.TTS_GENERATE, async (_event, req: IpcTtsGenerateRequest) => {
    return services.tts.generate(req)
  })

  ipcMain.handle(IPC_CHANNELS.TTS_GENERATE_FOR_MESSAGE, async (_event, messageId: string) => {
    await services.agent.regenerateTts(messageId)
    // The result is communicated via agent events (tts.ready / tts.error)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.TTS_PLAY_AUDIO, async (_event, audioPath: string) => {
    return services.tts.playAudio(audioPath)
  })

  ipcMain.handle(IPC_CHANNELS.TTS_STOP_AUDIO, async () => {
    return services.tts.stopAudio()
  })

  ipcMain.handle(IPC_CHANNELS.TTS_GET_SETTINGS, async () => {
    return services.tts.getSettings()
  })

  ipcMain.handle(IPC_CHANNELS.TTS_UPDATE_SETTINGS, async (_event, patch: Partial<LocalTtsSettings>) => {
    services.tts.updateSettings(patch)
    await reconfigureAgentServices(services)
    const publicSettings = services.settings.getPublicSettings()
    services.trace.append({ type: "settings.updated", settings: publicSettings })
    services.window.broadcastSettings(publicSettings)
  })

  ipcMain.handle(IPC_CHANNELS.TTS_OPEN_AUDIO_FOLDER, async () => {
    await shell.openPath(services.tts.getAudioOutputDir())
  })

  ipcMain.handle(IPC_CHANNELS.TTS_SELECT_AUDIO_DIR, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.TTS_READ_AUDIO, async (_event, audioPath: string) => {
    return services.tts.readAudio(audioPath)
  })
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function truncatePreview(value: string, max = 2400): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}
