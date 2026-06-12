import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type {
  PublicSettings, AppSettingsPublicPatch, DebugSnapshot,
  IpcTestModelConnectionRequest, IpcTestModelConnectionResponse,
  IpcSaveAudioRecordingRequest, IpcSaveAudioRecordingResponse,
  IpcSaveImageRequest, IpcSaveImageResponse,
  IpcReadArtifactRequest, IpcReadArtifactResponse,
  IpcSendUserMessageRequest, CompactInputAnchor, AvatarHitRegionRect,
  IpcTtsHealthCheckResponse, IpcTtsListVoicesResponse,
  IpcTtsRegisterVoiceRequest, IpcTtsGenerateRequest, IpcTtsGenerateResponse,
  LocalTtsSettings,
} from "@live2d-agent/shared"

const api = {
  /* ---- Agent ---- */
  sendUserMessage: (input: string | IpcSendUserMessageRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEND_USER_MESSAGE, input),
  retryLastUserMessage: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.RETRY_LAST_USER_MESSAGE),
  clearContext: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_CONTEXT),
  companionActivity: (input?: { source?: "user" | "tts" | "voice"; active?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPANION_ACTIVITY, input),
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
  testModelConnection: (input: IpcTestModelConnectionRequest): Promise<IpcTestModelConnectionResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_TEST_MODEL_CONNECTION, input),
  updateWorkspaceDir: (path: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_WORKSPACE, path),
  updateLive2DModelPath: (modelPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_LIVE2D_MODEL_PATH, modelPath),
  startWindowDrag: (windowType?: "avatar"): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_DRAG_START, windowType),
  endWindowDrag: (windowType?: "avatar"): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_DRAG_END, windowType),
  setMousePassthrough: (enabled: boolean, windowType?: "avatar"): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_MOUSE_PASSTHROUGH, enabled, windowType),
  setAvatarHitRegion: (rects: AvatarHitRegionRect[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_AVATAR_HIT_REGION, rects),

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
  openMemoryFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OPEN_FOLDER),
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

  /* ---- Image (user upload) ---- */
  saveImage: (request: IpcSaveImageRequest): Promise<IpcSaveImageResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_SAVE, request),
  readArtifact: (request: IpcReadArtifactRequest): Promise<IpcReadArtifactResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_READ, request),
  updateVoiceDebug: (input: Partial<{
    lastRecordingState: "idle" | "recording" | "finished" | "cancelled" | "error"
    lastAudioArtifact: { id: string; path: string; mimeType: string; size: number; durationMs: number; createdAt: number }
    lastSentFormat: "wav" | "mp3"
    lastError: string
  }>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.VOICE_DEBUG_UPDATE, input),

  /* ---- TTS (Phase 2) ---- */
  ttsHealthCheck: (): Promise<IpcTtsHealthCheckResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_HEALTH_CHECK),
  ttsListVoices: (): Promise<IpcTtsListVoicesResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_LIST_VOICES),
  ttsRegisterVoice: (request: IpcTtsRegisterVoiceRequest): Promise<{ ok: boolean; voiceId?: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_REGISTER_VOICE, request),
  ttsRenameVoice: (voiceId: string, displayName: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_RENAME_VOICE, voiceId, displayName),
  ttsDeleteVoice: (voiceId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_DELETE_VOICE, voiceId),
  ttsGenerate: (request: IpcTtsGenerateRequest): Promise<IpcTtsGenerateResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_GENERATE, request),
  ttsGenerateForMessage: (messageId: string): Promise<IpcTtsGenerateResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_GENERATE_FOR_MESSAGE, messageId),
  ttsPlayAudio: (audioPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_PLAY_AUDIO, audioPath),
  ttsStopAudio: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_STOP_AUDIO),
  ttsGetSettings: (): Promise<LocalTtsSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_GET_SETTINGS),
  ttsUpdateSettings: (patch: Partial<LocalTtsSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_UPDATE_SETTINGS, patch),
  ttsOpenAudioFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_OPEN_AUDIO_FOLDER),
  ttsSelectAudioDir: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_SELECT_AUDIO_DIR),
  ttsSelectPromptWav: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_SELECT_PROMPT_WAV),
  ttsReadAudio: (audioPath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_READ_AUDIO, audioPath),
}

contextBridge.exposeInMainWorld("petAgent", api)

export type PetAgentApi = typeof api
