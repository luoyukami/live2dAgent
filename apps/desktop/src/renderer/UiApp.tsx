import { useEffect, useRef, useState } from "react"
import type { AgentEvent, AgentMessage, AgentAction, AudioContextAttachment } from "@live2d-agent/agent-core"
import { mapEventToState, type AvatarState } from "@live2d-agent/live2d"
import {
  EMOTION_VALUES,
  type Emotion,
  type PublicSettings,
  type ReasoningEffort,
  type DebugSnapshot,
  type ImageContextAttachment,
  DEFAULT_LOCAL_TTS_SETTINGS,
} from "@live2d-agent/shared"
import { DebugPanel } from "./components/DebugPanel"
import { MessageBubble } from "./components/MessageBubble"
import { ApprovalBubble } from "./components/ApprovalBubble"
import { AudioAttachmentCard } from "./components/AudioAttachmentCard"
import { RecorderButton } from "./components/RecorderButton"
import { TtsSettingsSection } from "./components/TtsSettingsSection"
import { useAudioRecorder } from "./audio/useAudioRecorder"
import { useTtsManager } from "./hooks/useTtsManager"
import {
  SettingsForm,
  HOTKEY_HINT,
  EMOTION_IDLE_REVERT_MS,
  IDLE_EMOTION,
  hasVisibleText,
  normalizeFormDimension,
  mergeAddedMessage,
  defaultForm,
  buildCompanionWatchPatch,
  CompanionWatchSettingsSection,
  McpSettingsSection,
  formatAttachmentLabel,
  formatAttachmentSubLabel,
  messageContentToText,
  summarize,
} from "./renderer-shared"

function trimMessagesForRetry(items: AgentMessage[], errorMessageId: string): AgentMessage[] {
  const errorIndex = items.findIndex((message) => message.id === errorMessageId)
  if (errorIndex < 0) return items

  for (let index = errorIndex - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") return items.slice(0, index + 1)
  }

  return items.filter((message) => message.id !== errorMessageId)
}

/**
 * UiApp — Chat + settings + debug window (Phase 4 interactive UI root).
 *
 * Renders only the interactive UI portions: compact input bar, detail overlay
 * (chat / settings / debug), approval bubbles, and attachment management.
 * The Live2D stage is displayed in the separate avatar window (AvatarApp).
 *
 * This component handles only the interactive UI portions: compact input bar, detail overlay
 * (chat / settings / debug), approval bubbles, and attachment management.
 * The Live2D stage is displayed in the separate avatar window (AvatarApp).
 */

export function UiApp(): JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pending, setPending] = useState<AgentAction[]>([])
  const [status, setStatus] = useState<AvatarState>("idle")
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [form, setForm] = useState<SettingsForm>(defaultForm)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelConnectionStatus, setModelConnectionStatus] = useState<"idle" | "checking" | "success" | "error">("idle")
  const [modelConnectionMessage, setModelConnectionMessage] = useState<string | null>(null)
  const [currentEmotion, setCurrentEmotion] = useState<Emotion | null>(null)

  /* ---- Debug states ---- */
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null)
  const [traceEvents, setTraceEvents] = useState<Array<{ ts: number; event: AgentEvent }>>([])
  const [lastManualResult, setLastManualResult] = useState<unknown>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /* ---- Voice input state ---- */
  const [attachments, setAttachments] = useState<AudioContextAttachment[]>([])
  const [imageAttachments, setImageAttachments] = useState<ImageContextAttachment[]>([])
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const recorder = useAudioRecorder({
    maxDurationMs: settings?.voice?.maxDurationMs,
    onAutoStop: (blob) => {
      void handleRecordingFinished(blob)
    },
  })

  /* ---- Layout states ---- */
  const [showInput, setShowInput] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [detailTab, setDetailTab] = useState<"chat" | "settings" | "debug">("chat")
  const [activeSettingsSection, setActiveSettingsSection] = useState<"general" | "presets" | "emotion" | "voice" | "tts" | "companion" | "mcp">("general")

  /* ---- TTS state ---- */
  const ttsManager = useTtsManager()

  /* ---- Effects ---- */

  useEffect(() => {
    if (showInput || showDetail) {
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [showInput, showDetail, detailTab])

  useEffect(() => {
    // Prevent Electron from opening dragged files in a new window.
    // We handle drops ourselves in the input bar / footer.
    const preventDefault = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener("dragover", preventDefault)
    document.addEventListener("drop", preventDefault)
    return () => {
      document.removeEventListener("dragover", preventDefault)
      document.removeEventListener("drop", preventDefault)
    }
  }, [])

  useEffect(() => {
    window.petAgent.getSettings().then(setSettings)
    return window.petAgent.onSettingsUpdated?.((updated) => {
      setSettings(updated)
    })
  }, [])

  /* ---- Agent event subscription ---- */
  const ttsEventHandlerRef = useRef(ttsManager.handleAgentEvent)
  useEffect(() => {
    ttsEventHandlerRef.current = ttsManager.handleAgentEvent
  }, [ttsManager.handleAgentEvent])

  useEffect(() => {
    return window.petAgent.onAgentEvent((event: AgentEvent) => {
      const nextState = mapEventToState(event)
      if (nextState) setStatus(nextState)
      if (event.type === "message.created") {
        setMessages((items) => {
          if (items.some((m) => m.id === event.message.id)) return items
          return [...items, {
            id: event.message.id,
            role: event.message.role,
            content: event.message.content ?? "",
            createdAt: event.message.createdAt,
          } satisfies AgentMessage]
        })
      }
      if (event.type === "message.delta") {
        setMessages((items) => items.map((m) =>
          m.id === event.messageId
            ? { ...m, content: m.content + event.delta }
            : m,
        ))
      }
      // message.completed is a no-op — content is already final via deltas
      if (event.type === "message.added") {
        setMessages((items) => mergeAddedMessage(items, event.message))
      }
      if (event.type === "approval.pending") setPending(event.actions)
      if (event.type === "approval.approved" || event.type === "approval.denied") setPending([])
      if (event.type === "emotion.set") {
        setCurrentEmotion(event.emotion)
      }
      if (event.type === "tts.generating" || event.type === "tts.ready" || event.type === "tts.error" || event.type === "tts.playing" || event.type === "tts.stopped") {
        ttsEventHandlerRef.current(event)
      }
    })
  }, [])

  useEffect(() => {
    if (settings) {
      setForm((prev) => ({
        ...prev,
        mode: settings.mode,
        openaiBaseUrl: settings.openaiBaseUrl,
        openaiModel: settings.openaiModel,
        openaiMultimodalModel: settings.openaiMultimodalModel ?? "",
        reasoningEffort: settings.reasoningEffort ?? "low",
        workspaceDir: settings.workspaceDir,
        live2dModelPath: settings.live2d?.modelPath ?? "",
        streamingEnabled: settings.agent?.streamingEnabled ?? true,
        permissionMode: settings.permissions?.mode ?? "permissive",
        windowWidth: String(settings.ui?.width ?? prev.windowWidth),
        windowHeight: String(settings.ui?.height ?? prev.windowHeight),
        panelWidth: String(settings.ui?.panelWidth ?? prev.panelWidth),
        panelHeight: String(settings.ui?.panelHeight ?? prev.panelHeight),
        promptPresets: settings.promptPresets ?? prev.promptPresets,
        emotion: {
          enabled: settings.emotion?.enabled ?? prev.emotion.enabled,
          injectPrompt: settings.emotion?.injectPrompt ?? prev.emotion.injectPrompt,
          defaultEmotion: settings.emotion?.defaultEmotion ?? prev.emotion.defaultEmotion,
          stripTagWhenDisabled: settings.emotion?.stripTagWhenDisabled ?? prev.emotion.stripTagWhenDisabled,
        },
        voice: settings.voice ?? prev.voice,
        companionWatch: settings.companionWatch ?? prev.companionWatch,
        mcp: settings.mcp ?? prev.mcp,
        tts: {
          enabled: settings.tts?.enabled ?? prev.tts.enabled,
          apiBaseUrl: settings.tts?.apiBaseUrl ?? prev.tts.apiBaseUrl,
          selectedVoiceId: settings.tts?.selectedVoiceId ?? prev.tts.selectedVoiceId,
          voiceDisplayNames: settings.tts?.voiceDisplayNames ?? prev.tts.voiceDisplayNames,
          ttsMode: settings.tts?.ttsMode ?? prev.tts.ttsMode,
          emotionControlMode: settings.tts?.emotionControlMode ?? prev.tts.emotionControlMode,
          speed: settings.tts?.speed ?? prev.tts.speed,
          seed: settings.tts?.seed ?? prev.tts.seed,
          audioOutputDir: settings.tts?.audioOutputDir ?? prev.tts.audioOutputDir,
          autoGenerateOnAssistantMessage: settings.tts?.autoGenerateOnAssistantMessage ?? prev.tts.autoGenerateOnAssistantMessage,
          autoPlayAfterGenerate: settings.tts?.autoPlayAfterGenerate ?? prev.tts.autoPlayAfterGenerate,
          requestTimeoutMs: settings.tts?.requestTimeoutMs ?? prev.tts.requestTimeoutMs,
        },
      }))
    }
  }, [settings])

  /* Auto-revert to idle after transient states */
  useEffect(() => {
    if (status === "success") {
      const timer = setTimeout(() => setStatus("idle"), 1500)
      return () => clearTimeout(timer)
    }
    if (status === "error") {
      const timer = setTimeout(() => setStatus("idle"), 2000)
      return () => clearTimeout(timer)
    }
  }, [status])

  /* Fallback: return temporary emotion tags to the configured default emotion after inactivity. */
  useEffect(() => {
    if (settings?.emotion?.enabled === false) return
    const defaultEmotion = settings?.emotion?.defaultEmotion ?? IDLE_EMOTION
    if (currentEmotion === null || currentEmotion === defaultEmotion) return

    const timer = setTimeout(() => {
      setCurrentEmotion(defaultEmotion)
    }, EMOTION_IDLE_REVERT_MS)

    return () => clearTimeout(timer)
  }, [currentEmotion, settings?.emotion?.defaultEmotion, settings?.emotion?.enabled])

  /* Emotion system disabled ⇒ renderer must not apply a fallback emotion. */
  useEffect(() => {
    if (settings && settings.emotion && !settings.emotion.enabled) {
      setCurrentEmotion(null)
    }
  }, [settings?.emotion?.enabled])

  /* ---- Listen to main process UI commands ---- */
  useEffect(() => {
    return window.petAgent.onUiCommand?.((command) => {
      if (command.mode === "hidden") {
        setShowInput(false)
        setShowDetail(false)
        return
      }
      if (command.mode === "compact") {
        setShowInput(true)
        setShowDetail(false)
        setTimeout(() => textareaRef.current?.focus(), 0)
        return
      }
      if (command.mode === "detail") {
        setShowInput(false)
        setShowDetail(true)
        setDetailTab(command.tab ?? "chat")
        if (command.tab === "debug") void refreshDebug()
        return
      }
    })
  }, [])

  /* Surface recorder errors to the user + main process debug state. */
  useEffect(() => {
    if (recorder.error) {
      setRecordingError(recorder.error)
      void window.petAgent.updateVoiceDebug?.({ lastError: recorder.error, lastRecordingState: "error" })
    } else {
      setRecordingError(null)
    }
  }, [recorder.error, recorder.status])

  /* Push a `recording.started` trace event the first time the recorder
   * transitions into the recording state. */
  const recordingPhaseRef = useRef<typeof recorder.status>(recorder.status)
  useEffect(() => {
    if (recordingPhaseRef.current !== "recording" && recorder.status === "recording") {
      void window.petAgent.appendTraceEvent?.({
        type: "recording.started",
        maxDurationMs: settings?.voice?.maxDurationMs ?? 30_000,
        preferredFormat: settings?.voice?.preferredFormat ?? "wav",
      })
    }
    recordingPhaseRef.current = recorder.status
  }, [recorder.status, settings?.voice?.maxDurationMs, settings?.voice?.preferredFormat])

  /* Keyboard shortcuts: Ctrl/Cmd+Shift+D toggles debug, Ctrl/Cmd+Alt+V toggles recording. */
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable
    }

    function onKeyDown(e: KeyboardEvent): void {
      // Don't intercept single-key shortcuts while the user is typing
      const typing = isTypingTarget(e.target)

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault()
        if (showDetail && detailTab === "debug") {
          // If debug panel is already open, close it
          void window.petAgent.hideUiWindow?.()
        } else {
          // Open debug panel
          void window.petAgent.showDetailPanel?.("debug")
        }
        return
      }

      // Push-to-talk: Ctrl/Cmd + Alt + V
      if (settings?.voice?.enabled && !typing) {
        if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
          e.preventDefault()
          void handleHotkeyToggle()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [settings?.voice?.enabled, recorder.status, showDetail, detailTab])

  /* ---- Voice input handlers ---- */

  async function handleStartRecording(): Promise<void> {
    setRecordingError(null)
    void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "recording" })
    try {
      await recorder.start()
    } catch {
      // The hook already sets recorder.error; we don't need to throw.
    }
  }

  async function handleRecordingFinished(blob: Blob | null): Promise<void> {
    if (!blob) {
      setRecordingError(null)
      void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "cancelled" })
      void window.petAgent.appendTraceEvent?.({ type: "recording.cancelled" })
      return
    }
    try {
      const arrayBuffer = await blob.arrayBuffer()
      const durationMs = recorder.durationMs || 0
      const result = await window.petAgent.saveAudioRecording({
        data: arrayBuffer,
        mimeType: blob.type || "audio/wav",
        durationMs,
        preferredFormat: settings?.voice?.preferredFormat ?? "wav",
      })
      if (result.ok && result.attachment) {
        setAttachments((prev) => [...prev, result.attachment!])
        void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "finished" })
        void window.petAgent.appendTraceEvent?.({
          type: "recording.finished",
          durationMs,
          mimeType: result.attachment.mimeType,
          size: result.attachment.artifact.size,
        })
        void window.petAgent.appendTraceEvent?.({ type: "audio.attachment.added", attachment: result.attachment })
      } else {
        const msg = result.error?.message ?? "保存录音失败"
        setRecordingError(msg)
        void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "error", lastError: msg })
        void window.petAgent.appendTraceEvent?.({ type: "audio.error", code: "save_failed", message: msg })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRecordingError(msg)
      void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "error", lastError: msg })
      void window.petAgent.appendTraceEvent?.({ type: "audio.error", code: "save_failed", message: msg })
    }
  }

  async function handleStopRecording(): Promise<void> {
    setRecordingError(null)
    try {
      const blob = await recorder.stop()
      await handleRecordingFinished(blob)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRecordingError(msg)
      void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "error", lastError: msg })
      void window.petAgent.appendTraceEvent?.({ type: "audio.error", code: "save_failed", message: msg })
    }
  }

  function handleCancelRecording(): void {
    recorder.cancel()
    void window.petAgent.updateVoiceDebug?.({ lastRecordingState: "cancelled" })
    void window.petAgent.appendTraceEvent?.({ type: "recording.cancelled" })
  }

  async function handleHotkeyToggle(): Promise<void> {
    if (recorder.status === "recording") {
      await handleStopRecording()
    } else if (recorder.status === "idle" || recorder.status === "error") {
      await handleStartRecording()
    }
  }

  function handleRemoveAttachment(id: string): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
    void window.petAgent.appendTraceEvent?.({ type: "audio.attachment.removed", attachmentId: id })
  }

  function handleRemoveImageAttachment(id: string): void {
    setImageAttachments((prev) => prev.filter((a) => a.id !== id))
    void window.petAgent.appendTraceEvent?.({ type: "image.attachment.removed", attachmentId: id })
  }

  async function handleDropFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (imageFiles.length === 0) return

    for (const file of imageFiles) {
      try {
        const arrayBuffer = await file.arrayBuffer()
        const result = await window.petAgent.saveImage({
          data: arrayBuffer,
          mimeType: file.type,
          fileName: file.name,
        })
        if (result.ok && result.attachment) {
          setImageAttachments((prev) => [...prev, result.attachment!])
          void window.petAgent.appendTraceEvent?.({ type: "image.attachment.added", attachment: result.attachment })
        } else if (result.error) {
          setRecordingError(`图片保存失败: ${result.error.message}`)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setRecordingError(`图片处理失败: ${message}`)
      }
    }
  }

  /* ---- Send flow ---- */

  async function submit(): Promise<void> {
    const text = input.trim()
    if ((!text && attachments.length === 0 && imageAttachments.length === 0) || isSending) return
    setInput("")
    const outgoingAttachments = attachments
    const outgoingImageAttachments = imageAttachments
    setAttachments([])
    setImageAttachments([])
    setIsSending(true)
    try {
      const payload: { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: Array<{ id: string; kind: string; path: string; mimeType: string; size: number; createdAt: number }> } = { text }
      if (outgoingAttachments.length > 0) {
        payload.attachments = outgoingAttachments
        void window.petAgent.updateVoiceDebug?.({ lastSentFormat: outgoingAttachments[0]?.mimeType === "audio/mpeg" ? "mp3" : "wav" })
      }
      if (outgoingImageAttachments.length > 0) {
        payload.artifactRefs = outgoingImageAttachments.map((att) => att.artifact)
      }
      await window.petAgent.sendUserMessage(payload)
    } finally {
      setIsSending(false)
    }
  }

  async function clearVisibleMessages(): Promise<void> {
    setMessages([])
    setPending([])
    setStatus("idle")
    setCurrentEmotion(settings?.emotion?.defaultEmotion ?? IDLE_EMOTION)
    await window.petAgent.clearContext()
  }

  async function handleRetryLastUserMessage(errorMessageId: string): Promise<void> {
    if (isSending) return
    setIsSending(true)
    try {
      setMessages((items) => trimMessagesForRetry(items, errorMessageId))
      await window.petAgent.retryLastUserMessage()
    } finally {
      setIsSending(false)
    }
  }

  async function saveSettings(): Promise<void> {
    try {
      setSettingsError(null)
      if (form.workspaceDir !== settings?.workspaceDir) {
        await window.petAgent.updateWorkspaceDir(form.workspaceDir)
      }
      if (form.live2dModelPath !== (settings?.live2d?.modelPath ?? "")) {
        await window.petAgent.updateLive2DModelPath(form.live2dModelPath)
      }
      if (form.apiKey.trim()) {
        await window.petAgent.updateApiKey(form.apiKey.trim())
      }

      const publicPatch: Record<string, unknown> = {}
      if (form.mode !== settings?.mode) publicPatch.mode = form.mode
      if (form.openaiBaseUrl !== settings?.openaiBaseUrl) publicPatch.openaiBaseUrl = form.openaiBaseUrl
      if (form.openaiModel !== settings?.openaiModel) publicPatch.openaiModel = form.openaiModel
      if (form.openaiMultimodalModel !== (settings?.openaiMultimodalModel ?? "")) publicPatch.openaiMultimodalModel = form.openaiMultimodalModel
      if (form.reasoningEffort !== (settings?.reasoningEffort ?? "low")) publicPatch.reasoningEffort = form.reasoningEffort
      if (form.permissionMode !== settings?.permissions?.mode) publicPatch.permissions = { mode: form.permissionMode }
      if (form.streamingEnabled !== (settings?.agent?.streamingEnabled ?? true)) {
        publicPatch.agent = { ...((publicPatch.agent as Record<string, unknown> | undefined) ?? {}), streamingEnabled: form.streamingEnabled }
      }

      const nextWindowWidth = normalizeFormDimension(form.windowWidth, settings?.ui?.width ?? 360)
      const nextWindowHeight = normalizeFormDimension(form.windowHeight, settings?.ui?.height ?? 720)
      const nextPanelWidth = normalizeFormDimension(form.panelWidth, settings?.ui?.panelWidth ?? 460)
      const nextPanelHeight = normalizeFormDimension(form.panelHeight, settings?.ui?.panelHeight ?? 760)
      const uiPatch: Record<string, unknown> = {}
      if (nextWindowWidth !== (settings?.ui?.width ?? 360)) uiPatch.width = nextWindowWidth
      if (nextWindowHeight !== (settings?.ui?.height ?? 720)) uiPatch.height = nextWindowHeight
      if (nextPanelWidth !== (settings?.ui?.panelWidth ?? 460)) uiPatch.panelWidth = nextPanelWidth
      if (nextPanelHeight !== (settings?.ui?.panelHeight ?? 760)) uiPatch.panelHeight = nextPanelHeight
      if (Object.keys(uiPatch).length > 0) publicPatch.ui = uiPatch

      const settingsPromptPresets = settings?.promptPresets
      const promptPresetPatch: Record<string, unknown> = {}
      if (form.promptPresets.rolePrompt !== (settingsPromptPresets?.rolePrompt ?? "")) {
        promptPresetPatch.rolePrompt = form.promptPresets.rolePrompt
      }
      if (form.promptPresets.userInfoPrompt !== (settingsPromptPresets?.userInfoPrompt ?? "")) {
        promptPresetPatch.userInfoPrompt = form.promptPresets.userInfoPrompt
      }
      if (Object.keys(promptPresetPatch).length > 0) {
        publicPatch.promptPresets = promptPresetPatch
      }

      const emotionPatch: Record<string, unknown> = {}
      const settingsEmotion = settings?.emotion
      if (form.emotion.enabled !== (settingsEmotion?.enabled ?? true)) {
        emotionPatch.enabled = form.emotion.enabled
      }
      if (form.emotion.injectPrompt !== (settingsEmotion?.injectPrompt ?? true)) {
        emotionPatch.injectPrompt = form.emotion.enabled
          ? form.emotion.injectPrompt
          : false
      }
      if (form.emotion.defaultEmotion !== (settingsEmotion?.defaultEmotion ?? "neutral")) {
        emotionPatch.defaultEmotion = form.emotion.defaultEmotion
      }
      if (form.emotion.stripTagWhenDisabled !== (settingsEmotion?.stripTagWhenDisabled ?? true)) {
        emotionPatch.stripTagWhenDisabled = form.emotion.stripTagWhenDisabled
      }
      if (Object.keys(emotionPatch).length > 0) {
        publicPatch.emotion = emotionPatch
      }

      const settingsVoice = settings?.voice
      if (settingsVoice) {
        const voicePatch: Record<string, unknown> = {}
        if (form.voice.enabled !== settingsVoice.enabled) voicePatch.enabled = form.voice.enabled
        if (form.voice.audioInputEnabled !== settingsVoice.audioInputEnabled) voicePatch.audioInputEnabled = form.voice.audioInputEnabled
        if (form.voice.preferredFormat !== settingsVoice.preferredFormat) voicePatch.preferredFormat = form.voice.preferredFormat
        if (form.voice.maxDurationMs !== settingsVoice.maxDurationMs) voicePatch.maxDurationMs = form.voice.maxDurationMs
        if (form.voice.pushToTalkHotkey !== settingsVoice.pushToTalkHotkey) voicePatch.pushToTalkHotkey = form.voice.pushToTalkHotkey
        if (Object.keys(voicePatch).length > 0) {
          publicPatch.voice = voicePatch
        }
      }

      /* ---- TTS patch ---- */
      const settingsTts = settings?.tts
      const ttsPatch: Record<string, unknown> = {}
      if (form.tts.enabled !== (settingsTts?.enabled ?? false)) ttsPatch.enabled = form.tts.enabled
      if (form.tts.apiBaseUrl !== (settingsTts?.apiBaseUrl ?? DEFAULT_LOCAL_TTS_SETTINGS.apiBaseUrl)) ttsPatch.apiBaseUrl = form.tts.apiBaseUrl
      if (form.tts.selectedVoiceId !== (settingsTts?.selectedVoiceId ?? "")) ttsPatch.selectedVoiceId = form.tts.selectedVoiceId
      if (form.tts.ttsMode !== (settingsTts?.ttsMode ?? "standard")) ttsPatch.ttsMode = form.tts.ttsMode
      if (form.tts.emotionControlMode !== (settingsTts?.emotionControlMode ?? "default_mapping")) ttsPatch.emotionControlMode = form.tts.emotionControlMode
      if (form.tts.speed !== (settingsTts?.speed ?? 1.0)) ttsPatch.speed = form.tts.speed
      if (form.tts.seed !== (settingsTts?.seed ?? -1)) ttsPatch.seed = form.tts.seed
      if (form.tts.audioOutputDir !== (settingsTts?.audioOutputDir ?? "")) ttsPatch.audioOutputDir = form.tts.audioOutputDir
      if (form.tts.autoGenerateOnAssistantMessage !== (settingsTts?.autoGenerateOnAssistantMessage ?? true)) ttsPatch.autoGenerateOnAssistantMessage = form.tts.autoGenerateOnAssistantMessage
      if (form.tts.autoPlayAfterGenerate !== (settingsTts?.autoPlayAfterGenerate ?? true)) ttsPatch.autoPlayAfterGenerate = form.tts.autoPlayAfterGenerate
      if (form.tts.requestTimeoutMs !== (settingsTts?.requestTimeoutMs ?? 120000)) ttsPatch.requestTimeoutMs = form.tts.requestTimeoutMs
      if (Object.keys(ttsPatch).length > 0) {
        publicPatch.tts = ttsPatch
      }

      const companionWatchPatch = buildCompanionWatchPatch(form, settings)
      if (companionWatchPatch) {
        publicPatch.companionWatch = companionWatchPatch
      }

      const settingsMcp = settings?.mcp
      const mcpPatch: Record<string, unknown> = {}
      if (form.mcp.enabled !== (settingsMcp?.enabled ?? false)) mcpPatch.enabled = form.mcp.enabled
      if (form.mcp.configPath !== (settingsMcp?.configPath ?? "")) mcpPatch.configPath = form.mcp.configPath
      if (form.mcp.defaultTimeoutMs !== (settingsMcp?.defaultTimeoutMs ?? 30000)) mcpPatch.defaultTimeoutMs = form.mcp.defaultTimeoutMs
      if (form.mcp.search.enabled !== (settingsMcp?.search?.enabled ?? false) ||
        form.mcp.search.autoRegisterServer !== (settingsMcp?.search?.autoRegisterServer ?? true) ||
        form.mcp.search.provider !== (settingsMcp?.search?.provider ?? "parallel") ||
        Boolean(form.mcp.search.parallelApiKey?.trim()) ||
        Boolean(form.mcp.search.braveApiKey?.trim())) {
        const searchPatch: Record<string, unknown> = {
          enabled: form.mcp.search.enabled,
          provider: form.mcp.search.provider,
          autoRegisterServer: form.mcp.search.autoRegisterServer,
        }
        if (form.mcp.search.parallelApiKey?.trim()) searchPatch.parallelApiKey = form.mcp.search.parallelApiKey.trim()
        if (form.mcp.search.braveApiKey?.trim()) searchPatch.braveApiKey = form.mcp.search.braveApiKey.trim()
        mcpPatch.search = searchPatch
      }
      if (Object.keys(mcpPatch).length > 0) publicPatch.mcp = mcpPatch

      if (Object.keys(publicPatch).length > 0) {
        await window.petAgent.updatePublicSettings(publicPatch)
      }

      const updated = await window.petAgent.getSettings()
      setSettings(updated)
      setForm((prev) => ({ ...prev, apiKey: "" }))
      // Don't close the panel after saving - keep it open
      // If user wants to close, they can use the close button
    } catch (err) {
      setSettingsError("保存设置失败：" + (err as Error).message)
    }
  }

  async function testModelConnection(): Promise<void> {
    setModelConnectionStatus("checking")
    setModelConnectionMessage(null)
    try {
      const result = await window.petAgent.testModelConnection({
        baseUrl: form.openaiBaseUrl,
        apiKey: form.apiKey.trim() || undefined,
      })
      if (!result.ok) {
        setModelConnectionStatus("error")
        setModelConnectionMessage(result.error ?? "连接失败")
        return
      }
      setModelOptions(result.models)
      setModelConnectionStatus("success")
      setModelConnectionMessage(`已获取 ${result.models.length} 个模型`)
    } catch (error) {
      setModelConnectionStatus("error")
      setModelConnectionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function clearApiKey(): Promise<void> {
    try {
      setSettingsError(null)
      await window.petAgent.updateApiKey("")
      const updated = await window.petAgent.getSettings()
      setSettings(updated)
      setForm((prev) => ({ ...prev, apiKey: "" }))
    } catch (err) {
      setSettingsError("清除 API Key 失败：" + (err as Error).message)
    }
  }

  /* ---- Debug helpers ---- */
  async function refreshDebug(): Promise<void> {
    try {
      const snap = await window.petAgent.getDebugSnapshot()
      setSnapshot(snap)
      setLastManualResult(snap.lastToolResult)
    } catch {
      // ignore
    }
    try {
      const trace = await window.petAgent.getTraceEvents()
      setTraceEvents(trace)
    } catch {
      // ignore
    }
  }

  async function handleRunManualAction(tool: string, args: unknown): Promise<void> {
    await window.petAgent.runManualAction(tool, args)
    await new Promise((r) => setTimeout(r, 400))
    await refreshDebug()
  }

  function fillInput(text: string): void {
    setInput(text)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  async function sendFromPreset(text: string): Promise<void> {
    if (isSending) return
    setInput("")
    setIsSending(true)
    try {
      await window.petAgent.sendUserMessage({ text })
    } finally {
      setIsSending(false)
    }
  }

  const voiceEnabled = settings?.voice?.enabled ?? true

  const settingsTabs = [
    { key: "general" as const, label: "基础" },
    { key: "presets" as const, label: "预设" },
    { key: "emotion" as const, label: "情绪" },
    { key: "voice" as const, label: "语音" },
    { key: "tts" as const, label: "TTS" },
    { key: "companion" as const, label: "陪看" },
    { key: "mcp" as const, label: "MCP" },
  ]

  const canSubmit = !isSending && (input.trim().length > 0 || attachments.length > 0 || imageAttachments.length > 0)

  return (
    <main className="shell ui-shell">
      {/* Floating approval bubbles */}
      {pending.length > 0 && (
        <div className="floating-approvals">
          {pending.map((action) => (
            <ApprovalBubble key={action.id} action={action} />
          ))}
        </div>
      )}

      {/* Compact input bar */}
      {showInput && (
        <div
          className="compact-bar"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy" }}
          onDrop={(e) => { e.preventDefault(); void handleDropFiles(e.dataTransfer.files) }}
        >
          <div className="compact-bar-inner">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                void window.petAgent.companionActivity?.({ source: "user" })
                setInput(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder={
                attachments.length > 0 || imageAttachments.length > 0
                  ? "可补充文字，或直接发送…"
                  : "点击助手后输入消息，或拖入图片..."
              }
              rows={1}
            />
            {voiceEnabled && (
              <RecorderButton
                status={recorder.status}
                durationMs={recorder.durationMs}
                disabled={!recorder.isSupported}
                onStart={() => void handleStartRecording()}
                onStop={() => void handleStopRecording()}
                onCancel={handleCancelRecording}
                title={!recorder.isSupported ? "当前环境不支持录音" : `录音 (Ctrl/Cmd + Alt + V)`}
              />
            )}
            <button
              className="send-btn"
              onClick={() => void submit()}
              disabled={!canSubmit}
              title="发送"
            >
              ➤
            </button>
            <button
              className="icon-btn"
              onClick={() => void window.petAgent.showDetailPanel?.("chat")}
              title="展开详细界面"
            >
              ⛭
            </button>
            <button
              className="icon-btn"
              onClick={() => void window.petAgent.hideUiWindow?.()}
              title="收起输入栏"
            >
              ⬇
            </button>
          </div>
          {(attachments.length > 0 || imageAttachments.length > 0 || recordingError) && (
            <div className="compact-attachments">
              {attachments.map((att) => (
                <AudioAttachmentCard
                  key={att.id}
                  label={formatAttachmentLabel(att)}
                  subLabel={formatAttachmentSubLabel(att)}
                  onRemove={() => handleRemoveAttachment(att.id)}
                />
              ))}
              {imageAttachments.map((att) => (
                <AudioAttachmentCard
                  key={att.id}
                  icon="🖼"
                  label={att.label}
                  subLabel={`${(att.artifact.size / 1024).toFixed(1)} KB`}
                  onRemove={() => handleRemoveImageAttachment(att.id)}
                />
              ))}
              {recordingError && (
                <div className="recording-error">{recordingError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Full detail overlay */}
      {showDetail && (
        <div className="detail-overlay">
          <div className="detail-header">
            <div className="detail-tabs">
              <button
                className={detailTab === "chat" ? "active" : ""}
                onClick={() => setDetailTab("chat")}
              >
                对话
              </button>
              <button
                className={detailTab === "settings" ? "active" : ""}
                onClick={() => { setDetailTab("settings"); setSettingsError(null) }}
              >
                设置
              </button>
              <button
                className={detailTab === "debug" ? "active" : ""}
                onClick={() => { setDetailTab("debug"); void refreshDebug() }}
              >
                调试
              </button>
            </div>
            <div className="detail-header-actions">
              <select
                value={settings?.mode ?? "confirm"}
                onChange={async (event) => {
                  const mode = event.target.value as PublicSettings["mode"]
                  await window.petAgent.updatePublicSettings({ mode })
                  setSettings(settings ? { ...settings, mode } : settings)
                }}
                title="运行模式"
              >
                <option value="manual">manual</option>
                <option value="confirm">confirm</option>
                <option value="auto">auto</option>
              </select>
              <button className="icon-btn" onClick={clearVisibleMessages} title="仅清空当前显示，不删除 trace">
                清空
              </button>
              <button className="icon-btn" onClick={() => void window.petAgent.hideUiWindow?.()} title="返回简洁模式">
                ✕
              </button>
            </div>
          </div>

          <div className="detail-body">
            {detailTab === "chat" && (
              <div className="detail-chat">
                <div className="messages">
                  {messages
                    .filter((message) => message.role !== "system")
                    .map((message) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        messageAudioState={ttsManager.messageAudioStates.get(message.id)}
                        onGenerateTts={(id) => void ttsManager.generateForMessage(id)}
                        onPlayTts={(id) => ttsManager.playMessageAudio(id)}
                        onStopTts={() => ttsManager.stopPlayback()}
                        onRetryTts={(id) => void ttsManager.retryMessage(id)}
                        onRetryMessage={(id) => void handleRetryLastUserMessage(id)}
                      />
                    ))}
                </div>
                <footer
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy" }}
                  onDrop={(e) => { e.preventDefault(); void handleDropFiles(e.dataTransfer.files) }}
                >
                  {(attachments.length > 0 || imageAttachments.length > 0 || recordingError) && (
                    <div className="attachments-row">
                      {attachments.map((att) => (
                        <AudioAttachmentCard
                          key={att.id}
                          label={formatAttachmentLabel(att)}
                          subLabel={formatAttachmentSubLabel(att)}
                          onRemove={() => handleRemoveAttachment(att.id)}
                        />
                      ))}
                      {imageAttachments.map((att) => (
                        <AudioAttachmentCard
                          key={att.id}
                          icon="🖼"
                          label={att.label}
                          subLabel={`${(att.artifact.size / 1024).toFixed(1)} KB`}
                          onRemove={() => handleRemoveImageAttachment(att.id)}
                        />
                      ))}
                      {recordingError && (
                        <div className="recording-error">{recordingError}</div>
                      )}
                    </div>
                  )}
                  <div className="input-row">
                    <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(event) => {
                        void window.petAgent.companionActivity?.({ source: "user" })
                        setInput(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault()
                          void submit()
                        }
                      }}
                      placeholder={
                        attachments.length > 0 || imageAttachments.length > 0
                          ? "可补充文字，或直接发送…"
                          : "输入消息，或拖入图片..."
                      }
                    />
                    {voiceEnabled && (
                      <RecorderButton
                        status={recorder.status}
                        durationMs={recorder.durationMs}
                        disabled={!recorder.isSupported}
                        onStart={() => void handleStartRecording()}
                        onStop={() => void handleStopRecording()}
                        onCancel={handleCancelRecording}
                        title={!recorder.isSupported ? "当前环境不支持录音" : `录音 (Ctrl/Cmd + Alt + V)`}
                      />
                    )}
                    <button onClick={() => void submit()} disabled={!canSubmit}>
                      {isSending ? "发送中" : "发送"}
                    </button>
                  </div>
                </footer>
                <small className="status-line">
                  {status === "thinking"
                    ? "助手正在思考..."
                    : status === "running_tool"
                      ? "工具执行中..."
                      : "Enter 发送，Shift+Enter 换行"}
                </small>
              </div>
            )}

            {detailTab === "settings" && (
              <div className="detail-panel-wrapper">
                <div className="settings-header">
                  <b>设置</b>
                </div>

                <div className="settings-tabs">
                  {settingsTabs.map((t) => (
                    <button
                      key={t.key}
                      className={`settings-tab ${activeSettingsSection === t.key ? "active" : ""}`}
                      onClick={() => setActiveSettingsSection(t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="settings-body">
                  {activeSettingsSection === "general" && (
                    <>
                      <div className="settings-card">
                        <h3 className="settings-card-title">连接与模型</h3>
                        <div className="settings-group">
                          <label>API Key</label>
                          <div className="settings-row">
                            <input
                              type="password"
                              value={form.apiKey}
                              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                              placeholder="输入新的 API Key（留空表示不修改）"
                            />
                            <span className={`badge ${settings?.hasApiKey ? "ok" : "warn"}`}>
                              {settings?.hasApiKey ? "已配置" : "未配置"}
                            </span>
                            <button className="ghost-btn" onClick={() => void clearApiKey()} disabled={!settings?.hasApiKey}>
                              清除
                            </button>
                          </div>
                        </div>

                        <div className="settings-group">
                          <label>Base URL</label>
                          <div className="inline-input-row">
                            <input
                              value={form.openaiBaseUrl}
                              onChange={(e) => setForm((f) => ({ ...f, openaiBaseUrl: e.target.value }))}
                              placeholder="https://api.openai.com/v1"
                            />
                            <button className="ghost-btn" onClick={() => void testModelConnection()} disabled={modelConnectionStatus === "checking" || !form.openaiBaseUrl.trim()}>
                              {modelConnectionStatus === "checking" ? "连接中…" : "连接"}
                            </button>
                          </div>
                          {modelConnectionMessage ? <small className={`settings-hint ${modelConnectionStatus === "error" ? "danger" : ""}`}>{modelConnectionMessage}</small> : null}
                        </div>

                        <div className="settings-group">
                          <label>主要模型</label>
                          <input
                            list="ui-main-model-options"
                            value={form.openaiModel}
                            onChange={(e) => setForm((f) => ({ ...f, openaiModel: e.target.value }))}
                            placeholder="推荐选择速度快的模型"
                          />
                          <datalist id="ui-main-model-options">
                            {modelOptions.map((model) => <option key={model} value={model} />)}
                          </datalist>
                          <small className="settings-hint">普通文字消息会使用主要模型。</small>
                        </div>

                        <div className="settings-group">
                          <label>多模态专用模型（可选）</label>
                          <input
                            list="ui-multimodal-model-options"
                            value={form.openaiMultimodalModel}
                            onChange={(e) => setForm((f) => ({ ...f, openaiMultimodalModel: e.target.value }))}
                            placeholder="留空则所有消息使用主要模型"
                          />
                          <datalist id="ui-multimodal-model-options">
                            {modelOptions.map((model) => <option key={model} value={model} />)}
                          </datalist>
                          <small className="settings-hint">含语音或图片的消息会优先路由到该模型。</small>
                        </div>

                        <div className="settings-group">
                          <label>思考强度</label>
                          <select
                            value={form.reasoningEffort}
                            onChange={(e) => setForm((f) => ({ ...f, reasoningEffort: e.target.value as ReasoningEffort }))}
                          >
                            <option value="none">none（不发送）</option>
                            <option value="low">low（默认，更快）</option>
                            <option value="medium">medium</option>
                            <option value="high">high</option>
                          </select>
                          <small className="settings-hint">用于 OpenAI-compatible 请求的 reasoning_effort；none 表示不发送该参数。</small>
                        </div>
                      </div>

                      <div className="settings-card">
                        <h3 className="settings-card-title">运行与权限</h3>
                        <div className="settings-group">
                          <label>运行模式</label>
                          <select
                            value={form.mode}
                            onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as PublicSettings["mode"] }))}
                          >
                            <option value="manual">manual</option>
                            <option value="confirm">confirm</option>
                            <option value="auto">auto</option>
                          </select>
                        </div>

                        <div className="settings-group">
                          <label>工具权限</label>
                          <select
                            value={form.permissionMode}
                            onChange={(e) => setForm((f) => ({ ...f, permissionMode: e.target.value as PublicSettings["permissions"]["mode"] }))}
                          >
                            <option value="permissive">默许模式</option>
                            <option value="ask">询问模式</option>
                          </select>
                        </div>

                        <div className="settings-group">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={form.streamingEnabled}
                              onChange={(e) => setForm((f) => ({ ...f, streamingEnabled: e.target.checked }))}
                            />
                            <span>流式输出消息</span>
                          </label>
                          <small className="settings-hint">开启后，助手会边生成边显示文字；关闭后仍在完整回复生成后一次性显示。</small>
                        </div>
                      </div>

                      <div className="settings-card">
                        <h3 className="settings-card-title">工作区与展示</h3>
                        <div className="settings-group">
                          <label>Workspace 目录</label>
                          <input
                            value={form.workspaceDir}
                            onChange={(e) => setForm((f) => ({ ...f, workspaceDir: e.target.value }))}
                            placeholder="Workspace 路径"
                          />
                        </div>

                        <div className="settings-group">
                          <label>Live2D 模型路径</label>
                          <input
                            value={form.live2dModelPath}
                            onChange={(e) => setForm((f) => ({ ...f, live2dModelPath: e.target.value }))}
                            placeholder="model.json 或 .model3.json 路径"
                          />
                        </div>

                        <div className="settings-grid two-cols">
                          <div className="settings-group">
                            <label>Live2D展示宽度</label>
                            <input
                              type="number"
                              step={10}
                              value={form.windowWidth}
                              onChange={(e) => setForm((f) => ({ ...f, windowWidth: e.target.value }))}
                              onBlur={() => setForm((f) => ({ ...f, windowWidth: String(normalizeFormDimension(f.windowWidth, settings?.ui?.width ?? 360)) }))}
                            />
                          </div>
                          <div className="settings-group">
                            <label>Live2D展示高度</label>
                            <input
                              type="number"
                              step={10}
                              value={form.windowHeight}
                              onChange={(e) => setForm((f) => ({ ...f, windowHeight: e.target.value }))}
                              onBlur={() => setForm((f) => ({ ...f, windowHeight: String(normalizeFormDimension(f.windowHeight, settings?.ui?.height ?? 720)) }))}
                            />
                          </div>
                        </div>
                        <small className="settings-hint">展示宽高修改后立即生效。</small>

                        <div className="settings-grid two-cols">
                          <div className="settings-group">
                            <label>UI窗口宽度</label>
                            <input
                              type="number"
                              step={10}
                              value={form.panelWidth}
                              onChange={(e) => setForm((f) => ({ ...f, panelWidth: e.target.value }))}
                              onBlur={() => setForm((f) => ({ ...f, panelWidth: String(normalizeFormDimension(f.panelWidth, settings?.ui?.panelWidth ?? 460)) }))}
                            />
                          </div>
                          <div className="settings-group">
                            <label>UI窗口高度</label>
                            <input
                              type="number"
                              step={10}
                              value={form.panelHeight}
                              onChange={(e) => setForm((f) => ({ ...f, panelHeight: e.target.value }))}
                              onBlur={() => setForm((f) => ({ ...f, panelHeight: String(normalizeFormDimension(f.panelHeight, settings?.ui?.panelHeight ?? 760)) }))}
                            />
                          </div>
                        </div>
                        <small className="settings-hint">UI 窗口尺寸修改后需重启应用才能生效。</small>
                      </div>
                    </>
                  )}

                  {activeSettingsSection === "presets" && (
                    <div className="settings-card">
                      <h3 className="settings-card-title">提示词预设</h3>
                      <div className="settings-group">
                        <label>角色提示词</label>
                        <textarea
                          className="prompt-preset-textarea role"
                          value={form.promptPresets.rolePrompt}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            promptPresets: { ...f.promptPresets, rolePrompt: e.target.value },
                          }))}
                          placeholder="描述助手的角色、性格、语气、职责和边界"
                        />
                        <small className="settings-hint">
                          会被放入最终 system prompt 的“角色提示词”部分，用于定义助手身份、风格和长期职责。
                        </small>
                      </div>

                      <div className="settings-group">
                        <label>用户信息提示词</label>
                        <textarea
                          className="prompt-preset-textarea user-info"
                          value={form.promptPresets.userInfoPrompt}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            promptPresets: { ...f.promptPresets, userInfoPrompt: e.target.value },
                          }))}
                          placeholder="例如：用户偏好的称呼、语言风格、常用技术栈、作息习惯等（可留空）"
                        />
                        <small className="settings-hint">
                          会被放入最终 system prompt 的“用户信息提示词”部分。建议只填写稳定、愿意让模型长期参考的信息。
                        </small>
                      </div>
                    </div>
                  )}

                  {activeSettingsSection === "emotion" && (
                    <div className="settings-card">
                      <h3 className="settings-card-title">情绪标签</h3>
                      <div className="settings-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={form.emotion.enabled}
                            onChange={(e) => {
                              const nextEnabled = e.target.checked
                              setForm((f) => ({
                                ...f,
                                emotion: {
                                  ...f.emotion,
                                  enabled: nextEnabled,
                                  injectPrompt: nextEnabled ? true : false,
                                },
                              }))
                            }}
                          />
                          <span>启用情绪标签</span>
                        </label>
                        <small className="settings-hint">
                          开启后，助手会在回复末尾生成一个本地可解析的情绪标签，用于驱动 Live2D 等表现层。关闭后不会注入相关提示词，可减少 token 消耗。
                        </small>
                      </div>

                      <div className="settings-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={form.emotion.injectPrompt}
                            disabled={!form.emotion.enabled}
                            onChange={(e) => setForm((f) => ({ ...f, emotion: { ...f.emotion, injectPrompt: e.target.checked } }))}
                          />
                          <span>注入情绪提示词（高级）</span>
                        </label>
                        <small className="settings-hint">
                          控制是否在 system prompt 中追加 Assistant Emotion Tag 说明。关闭主开关时此项自动关闭。
                        </small>
                      </div>

                      <div className="settings-group">
                        <label>默认情绪</label>
                        <select
                          value={form.emotion.defaultEmotion}
                          onChange={(e) => setForm((f) => ({ ...f, emotion: { ...f.emotion, defaultEmotion: e.target.value as Emotion } }))}
                        >
                          {EMOTION_VALUES.map((value) => (
                            <option key={value} value={value}>{value}</option>
                          ))}
                        </select>
                        <small className="settings-hint">解析失败或情绪系统关闭时使用的回落情绪。</small>
                      </div>

                      <div className="settings-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={form.emotion.stripTagWhenDisabled}
                            onChange={(e) => setForm((f) => ({ ...f, emotion: { ...f.emotion, stripTagWhenDisabled: e.target.checked } }))}
                          />
                          <span>关闭时仍剥离尾部情绪标签</span>
                        </label>
                        <small className="settings-hint">关闭情绪系统后，如果模型仍输出尾部标签，是否从用户可见正文中移除。</small>
                      </div>
                    </div>
                  )}

                  {activeSettingsSection === "voice" && (
                    <div className="settings-card">
                      <h3 className="settings-card-title">语音输入</h3>
                      <div className="settings-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={form.voice.enabled}
                            onChange={(e) => {
                              const nextEnabled = e.target.checked
                              setForm((f) => ({
                                ...f,
                                voice: {
                                  ...f.voice,
                                  enabled: nextEnabled,
                                },
                              }))
                            }}
                          />
                          <span>启用语音输入</span>
                        </label>
                        <small className="settings-hint">{HOTKEY_HINT}</small>
                      </div>

                      <div className="settings-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={form.voice.audioInputEnabled}
                            disabled={!form.voice.enabled}
                            onChange={(e) => setForm((f) => ({ ...f, voice: { ...f.voice, audioInputEnabled: e.target.checked } }))}
                          />
                          <span>将音频发送给模型</span>
                        </label>
                        <small className="settings-hint">
                          关闭后录音仍会保存为附件，但模型不会收到 `input_audio` 多模态输入。适用于仅用作回放或留痕。
                        </small>
                      </div>

                      <div className="settings-group">
                        <label>首选音频格式</label>
                        <div className="settings-static-value">wav</div>
                        <small className="settings-hint">当前仅支持 wav。mp3 转码将在后续版本启用（设置项保留以便将来扩展）。</small>
                      </div>

                      <div className="settings-group">
                        <label>单次录音最大时长 (ms)</label>
                        <input
                          type="number"
                          min={1000}
                          max={300000}
                          step={1000}
                          value={form.voice.maxDurationMs}
                          onChange={(e) => {
                            const n = Number(e.target.value)
                            if (Number.isFinite(n)) setForm((f) => ({ ...f, voice: { ...f.voice, maxDurationMs: n } }))
                          }}
                        />
                        <small className="settings-hint">超过该时长录音自动停止。建议 10–60 秒。</small>
                      </div>

                      <div className="settings-group">
                        <label>快捷键 (Electron accelerator)</label>
                        <input
                          value={form.voice.pushToTalkHotkey}
                          onChange={(e) => setForm((f) => ({ ...f, voice: { ...f.voice, pushToTalkHotkey: e.target.value } }))}
                          placeholder="CommandOrControl+Alt+V"
                        />
                        <small className="settings-hint">{HOTKEY_HINT}</small>
                      </div>
                    </div>
                  )}

                  {activeSettingsSection === "tts" && (
                    <TtsSettingsSection
                      form={form}
                      setForm={setForm}
                      settings={settings}
                    />
                  )}

                  {activeSettingsSection === "companion" && (
                    <CompanionWatchSettingsSection
                      form={form}
                      setForm={setForm}
                    />
                  )}

                  {activeSettingsSection === "mcp" && (
                    <McpSettingsSection form={form} setForm={setForm} />
                  )}

                  {settingsError && <div className="settings-error">{settingsError}</div>}
                </div>

                <div className="settings-footer">
                  <button onClick={() => void saveSettings()}>保存</button>
                </div>
              </div>
            )}

            {detailTab === "debug" && (
              <div className="detail-panel-wrapper">
                <DebugPanel
                  snapshot={snapshot}
                  traceEvents={traceEvents}
                  onRefresh={refreshDebug}
                  onOpenTraceFolder={() => void window.petAgent.openTraceFolder()}
                  onOpenArtifactFolder={() => void window.petAgent.openArtifactFolder()}
                  onOpenPromptFolder={() => void window.petAgent.openPromptFolder()}
                  onOpenMemoryFolder={() => void window.petAgent.openMemoryFolder()}
                  onOpenAudioFolder={() => void window.petAgent.openAudioFolder?.()}
                  onReloadSettings={async () => {
                    try {
                      const s = await window.petAgent.reloadSettings()
                      setSettings(s)
                    } catch (err) {
                      alert("reloadSettings 失败: " + (err as Error).message)
                    }
                  }}
                  onReloadPrompt={() => void window.petAgent.reloadPrompt()}
                  onReloadLive2D={() => void window.petAgent.reloadLive2D()}
                  onClearMessages={clearVisibleMessages}
                  onRunManualAction={handleRunManualAction}
                  lastManualResult={lastManualResult}
                  onFillInput={fillInput}
                  onSendMessage={sendFromPreset}
                  onClose={() => void window.petAgent.hideUiWindow?.()}
                  activeEmotion={currentEmotion}
                  onSimulateEmotion={(emotion) => setCurrentEmotion(emotion)}
                  onClearEmotion={() => setCurrentEmotion(null)}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}

