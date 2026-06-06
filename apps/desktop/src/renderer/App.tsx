import { useEffect, useMemo, useRef, useState } from "react"
import type { AgentEvent, AgentMessage, AgentAction, AudioContextAttachment } from "@live2d-agent/agent-core"
import { mapEventToState, type AvatarState } from "@live2d-agent/live2d"
import {
  EMOTION_VALUES,
  type Emotion,
  type EmotionSettings,
  type PublicSettings,
  type ReasoningEffort,
  type DebugSnapshot,
  type VoiceInputSettings,
} from "@live2d-agent/shared"
import { Live2DView } from "./live2d/Live2DView"
import { DebugPanel } from "./components/DebugPanel"
import { AudioAttachmentCard } from "./components/AudioAttachmentCard"
import { RecorderButton } from "./components/RecorderButton"
import { useAudioRecorder } from "./audio/useAudioRecorder"

interface SettingsForm {
  mode: PublicSettings["mode"]
  openaiBaseUrl: string
  openaiModel: string
  reasoningEffort: ReasoningEffort
  apiKey: string
  workspaceDir: string
  live2dModelPath: string
  permissionMode: PublicSettings["permissions"]["mode"]
  emotion: EmotionSettings
  voice: VoiceInputSettings
}

const HOTKEY_HINT =
  "v0 快捷键仅在窗口聚焦时生效。当前实现固定为 Ctrl/Cmd + Alt + V，设置中保存的字符串仅用于显示和未来扩展。"

const RISK_TEXT: Record<string, string> = {
  safe: "安全操作",
  workspace_read: "读取工作区文件",
  workspace_write: "写入工作区文件，需要确认",
  screen_read: "读取屏幕截图，可能包含隐私信息",
  clipboard_read: "读取剪贴板，可能包含敏感信息",
  clipboard_write: "修改剪贴板内容",
  shell: "执行命令，可能修改文件或运行程序",
  dangerous: "高风险操作，默认拒绝",
}

function defaultForm(): SettingsForm {
  return {
    mode: "confirm",
    openaiBaseUrl: "",
    openaiModel: "",
    reasoningEffort: "low",
    apiKey: "",
    workspaceDir: "",
    live2dModelPath: "",
    permissionMode: "permissive",
    emotion: {
      enabled: true,
      injectPrompt: true,
      defaultEmotion: "neutral",
      stripTagWhenDisabled: true,
    },
    voice: {
      enabled: true,
      audioInputEnabled: true,
      preferredFormat: "wav",
      maxDurationMs: 30_000,
      pushToTalkHotkey: "CommandOrControl+Alt+V",
    },
  }
}

export function App(): JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pending, setPending] = useState<AgentAction[]>([])
  const [status, setStatus] = useState<AvatarState>("idle")
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [activeSettingsSection, setActiveSettingsSection] = useState<"general" | "emotion" | "voice">("general")
  const [form, setForm] = useState<SettingsForm>(defaultForm)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [currentEmotion, setCurrentEmotion] = useState<Emotion | null>(null)

  /* ---- v0.2 Debug states ---- */
  const [showDebug, setShowDebug] = useState(false)
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null)
  const [traceEvents, setTraceEvents] = useState<Array<{ ts: number; event: AgentEvent }>>([])
  const [lastManualResult, setLastManualResult] = useState<unknown>(null)
  const [live2dReloadKey, setLive2dReloadKey] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /* ---- v0 voice input state ---- */
  const [attachments, setAttachments] = useState<AudioContextAttachment[]>([])
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const recorder = useAudioRecorder({
    maxDurationMs: settings?.voice?.maxDurationMs,
    onAutoStop: (blob) => {
      void handleRecordingFinished(blob)
    },
  })

  /* ---- Live2D stage height with resize handle ---- */
  const [live2dHeight, setLive2dHeight] = useState(320)
  const resizeState = useRef<{ dragging: boolean; startY: number; startHeight: number } | null>(null)

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!resizeState.current?.dragging) return
      const delta = e.clientY - resizeState.current.startY
      const next = Math.max(160, Math.min(window.innerHeight - 220, resizeState.current.startHeight + delta))
      setLive2dHeight(next)
    }
    function onUp() {
      if (resizeState.current) resizeState.current.dragging = false
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [])

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>): void {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    resizeState.current = { dragging: true, startY: e.clientY, startHeight: live2dHeight }
  }

  useEffect(() => {
    window.petAgent.getSettings().then(setSettings)
    return window.petAgent.onAgentEvent((event: AgentEvent) => {
      const nextState = mapEventToState(event)
      if (nextState) setStatus(nextState)
      if (event.type === "message.added") setMessages((items) => [...items, event.message])
      if (event.type === "approval.pending") setPending(event.actions)
      if (event.type === "approval.approved" || event.type === "approval.denied") setPending([])
      if (event.type === "emotion.set") {
        setCurrentEmotion(event.emotion)
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
        reasoningEffort: settings.reasoningEffort ?? "low",
        workspaceDir: settings.workspaceDir,
        live2dModelPath: settings.live2d?.modelPath ?? "",
        permissionMode: settings.permissions?.mode ?? "permissive",
        emotion: {
          enabled: settings.emotion?.enabled ?? prev.emotion.enabled,
          injectPrompt: settings.emotion?.injectPrompt ?? prev.emotion.injectPrompt,
          defaultEmotion: settings.emotion?.defaultEmotion ?? prev.emotion.defaultEmotion,
          stripTagWhenDisabled: settings.emotion?.stripTagWhenDisabled ?? prev.emotion.stripTagWhenDisabled,
        },
        voice: settings.voice ?? prev.voice,
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

  /* Emotion system disabled ⇒ renderer must not apply a fallback emotion to Live2D. */
  useEffect(() => {
    if (settings && settings.emotion && !settings.emotion.enabled) {
      setCurrentEmotion(null)
    }
  }, [settings?.emotion?.enabled])

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
   * transitions into the recording state. Other transitions (cancelled,
   * finished) are pushed synchronously from the action handler. */
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
      // (Shift / Alt / Ctrl alone are not affected because they don't match
      // any of the patterns below).
      const typing = isTypingTarget(e.target)

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault()
        setShowDebug((prev) => {
          const next = !prev
          if (next) {
            void refreshDebug()
          }
          return next
        })
        return
      }

      // Push-to-talk: Ctrl/Cmd + Alt + V. The hotkey setting is consulted
      // for whether the feature is enabled, but we only support a
      // platform-agnostic ctrl/meta + alt + v matcher regardless of the
      // literal string in settings (which uses Electron's accelerator
      // grammar).
      if (settings?.voice?.enabled && !typing) {
        if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
          e.preventDefault()
          void handleHotkeyToggle()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [settings?.voice?.enabled, recorder.status])

  const assistantStateLabel = useMemo(() => ({
    idle: "空闲",
    thinking: "思考中",
    waiting_approval: "等待授权",
    running_tool: "执行工具",
    success: "完成",
    error: "出错",
  }[status]), [status])

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

  function formatAttachmentLabel(att: AudioContextAttachment): string {
    const seconds = (att.durationMs / 1000).toFixed(1)
    return `录音 ${seconds}s · ${att.mimeType.replace("audio/", "")}`
  }

  function formatAttachmentSubLabel(att: AudioContextAttachment): string {
    const sizeKb = (att.artifact.size / 1024).toFixed(1)
    return `${att.artifact.path.split(/[\\/]/).pop()} · ${sizeKb} KB`
  }

  /* ---- Send flow ---- */

  async function submit(): Promise<void> {
    const text = input.trim()
    if ((!text && attachments.length === 0) || isSending) return
    setInput("")
    const outgoingAttachments = attachments
    setAttachments([])
    setIsSending(true)
    try {
      const payload: { text: string; attachments?: AudioContextAttachment[] } = { text }
      if (outgoingAttachments.length > 0) {
        payload.attachments = outgoingAttachments
        void window.petAgent.updateVoiceDebug?.({ lastSentFormat: outgoingAttachments[0]?.mimeType === "audio/mpeg" ? "mp3" : "wav" })
      }
      await window.petAgent.sendUserMessage(payload)
    } finally {
      setIsSending(false)
    }
  }

  function clearVisibleMessages(): void {
    setMessages([])
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
      if (form.reasoningEffort !== (settings?.reasoningEffort ?? "low")) publicPatch.reasoningEffort = form.reasoningEffort
      if (form.permissionMode !== settings?.permissions?.mode) publicPatch.permissions = { mode: form.permissionMode }

      // Master switch off ⇒ force the prompt-injection switch off too, so the
      // settings on disk reflect what the agent is actually doing.
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

      // Voice settings patch
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

      if (Object.keys(publicPatch).length > 0) {
        await window.petAgent.updatePublicSettings(publicPatch)
      }

      const updated = await window.petAgent.getSettings()
      setSettings(updated)
      setForm((prev) => ({ ...prev, apiKey: "" }))
      setShowSettings(false)
    } catch (err) {
      setSettingsError("保存设置失败：" + (err as Error).message)
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
    // give main process a moment to update snapshot/trace
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
    { key: "emotion" as const, label: "情绪" },
    { key: "voice" as const, label: "语音" },
  ]

  return (
    <main className="shell">
      <section className="stage" style={{ height: live2dHeight }} data-state={status}>
        <div className="drag-region" />
        <div className="stage-content">
          <Live2DView
            key={live2dReloadKey}
            modelPath={settings?.live2d?.modelPath ?? ""}
            avatarState={status}
            emotion={currentEmotion}
            emotionProfile={settings?.live2d?.emotionProfile}
          />
          <span className="stage-status">{assistantStateLabel}</span>
        </div>
      </section>

      <div className="resize-handle" onPointerDown={handleResizeStart} />

      <section className="chat">
        <header>
          <div className="header-title">
            <strong>Pet Agent v0</strong>
            <small>
              {settings?.hasApiKey
                ? `${settings.openaiModel} · API Key 已配置`
                : "API Key 未配置 · 请在设置中填写"}
            </small>
          </div>
          <div className="header-actions">
            <select
              value={settings?.mode ?? "confirm"}
              onChange={async (event) => {
                const mode = event.target.value as PublicSettings["mode"]
                await window.petAgent.updatePublicSettings({ mode })
                setSettings(settings ? { ...settings, mode } : settings)
              }}
            >
              <option value="manual">manual</option>
              <option value="confirm">confirm</option>
              <option value="auto">auto</option>
            </select>
            <button className="icon-btn" onClick={() => { setShowDebug((s) => { if (!s) void refreshDebug(); return !s }); setShowSettings(false) }} title="Debug (Ctrl+Shift+D)">
              🐛
            </button>
            <button className="icon-btn" onClick={() => { setShowSettings((s) => !s); setSettingsError(null); setShowDebug(false) }} title="设置">
              ⚙
            </button>
            <button className="icon-btn" onClick={clearVisibleMessages} title="仅清空当前显示，不删除 trace">
              清空
            </button>
          </div>
        </header>

        {showSettings && (
          <div className="settings-overlay">
            <div className="settings-header">
              <b>设置</b>
              <button className="icon-btn" onClick={() => setShowSettings(false)} title="关闭">
                ✕
              </button>
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
                      <input
                        value={form.openaiBaseUrl}
                        onChange={(e) => setForm((f) => ({ ...f, openaiBaseUrl: e.target.value }))}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>

                    <div className="settings-group">
                      <label>模型</label>
                      <input
                        value={form.openaiModel}
                        onChange={(e) => setForm((f) => ({ ...f, openaiModel: e.target.value }))}
                        placeholder="gpt-4o-mini"
                      />
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
                  </div>
                </>
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

              {settingsError && <div className="settings-error">{settingsError}</div>}
            </div>

            <div className="settings-footer">
              <button onClick={() => void saveSettings()}>保存</button>
            </div>
          </div>
        )}

        {showDebug && (
          <DebugPanel
            snapshot={snapshot}
            traceEvents={traceEvents}
            onRefresh={refreshDebug}
            onOpenTraceFolder={() => void window.petAgent.openTraceFolder()}
            onOpenArtifactFolder={() => void window.petAgent.openArtifactFolder()}
            onOpenPromptFolder={() => void window.petAgent.openPromptFolder()}
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
            onReloadLive2D={async () => {
              await window.petAgent.reloadLive2D()
              setLive2dReloadKey((key) => key + 1)
            }}
            onClearMessages={clearVisibleMessages}
            onRunManualAction={handleRunManualAction}
            lastManualResult={lastManualResult}
            onFillInput={fillInput}
            onSendMessage={sendFromPreset}
            onClose={() => setShowDebug(false)}
          />
        )}

        <div className="messages">
          {messages
            .filter((message) => message.role !== "system")
            .map((message) => <MessageBubble key={message.id} message={message} />)}
        </div>

        {pending.map((action) => (
          <ApprovalBubble key={action.id} action={action} />
        ))}

        <footer>
          {(attachments.length > 0 || recordingError) && (
            <div className="attachments-row">
              {attachments.map((att) => (
                <AudioAttachmentCard
                  key={att.id}
                  label={formatAttachmentLabel(att)}
                  subLabel={formatAttachmentSubLabel(att)}
                  onRemove={() => handleRemoveAttachment(att.id)}
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
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder={
                attachments.length > 0
                  ? "可补充文字，或直接发送录音…"
                  : "输入消息..."
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
                title={!recorder.isSupported ? "当前环境不支持录音" : `录音 (Ctrl/Cmd + Alt + V，窗口聚焦时生效)`}
              />
            )}
            <button onClick={() => void submit()} disabled={isSending || (input.trim() === "" && attachments.length === 0)}>
              {isSending ? "发送中" : "发送"}
            </button>
          </div>
        </footer>
        <small className="status-line">
          {status === "thinking" ? "助手正在思考..." : status === "running_tool" ? "工具执行中..." : "Enter 发送，Shift+Enter 换行"}
        </small>
      </section>
    </main>
  )
}

function MessageBubble({ message }: { message: AgentMessage }): JSX.Element {
  const [expanded, setExpanded] = useState(message.role !== "tool")
  const text = messageContentToText(message)
  const isError = Boolean(message.extra?.error) || /^(API error|Network error|Invalid JSON|Model returned|Error executing)/i.test(text)
  const audioAttachments = (message.attachments ?? []).filter((a) => a.type === "audio")

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
  }

  return (
    <article className={`bubble ${message.role} ${isError ? "error" : ""}`}>
      <div className="message-head">
        <b>{message.role}</b>
        <div className="message-actions">
          {message.role === "tool" && (
            <button className="ghost-btn" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "折叠" : "展开"}
            </button>
          )}
          <button className="ghost-btn" onClick={() => void copy()}>复制</button>
        </div>
      </div>
      {audioAttachments.length > 0 && (
        <div className="message-attachments">
          {audioAttachments.map((att) => (
            <AudioAttachmentCard
              key={att.id}
              label={`录音 ${(att.durationMs / 1000).toFixed(1)}s`}
              subLabel={`${att.mimeType} · ${(att.artifact.size / 1024).toFixed(1)} KB`}
            />
          ))}
        </div>
      )}
      {expanded ? <p>{text}</p> : <p className="tool-summary">{summarize(text, 160)}</p>}
    </article>
  )
}

function ApprovalBubble({ action }: { action: AgentAction }): JSX.Element {
  const risk = riskForTool(action.tool)
  const args = asRecord(action.args)
  const allowLabel = risk === "screen_read" ? "允许本会话" : "允许"

  return (
    <article className="approval">
      <div className="approval-head">
        <b>请求权限：{action.tool}</b>
        <span className={`risk-badge ${risk}`}>{risk}</span>
      </div>
      <small>{RISK_TEXT[risk]}</small>
      <div className="approval-summary">{renderActionSummary(action.tool, args)}</div>
      <details>
        <summary>查看完整参数</summary>
        <code>{JSON.stringify(action.args, null, 2)}</code>
      </details>
      <div className="approval-actions">
        <button onClick={() => window.petAgent.approveAction(action.id)}>{allowLabel}</button>
        <button className="danger-btn" onClick={() => window.petAgent.denyAction(action.id, "User denied this tool-call round")}>拒绝本轮工具调用</button>
      </div>
    </article>
  )
}

function renderActionSummary(tool: string, args: Record<string, unknown>): JSX.Element {
  if (tool === "shell.run") {
    return <><span>命令：{String(args.command ?? "")}</span><span>工作目录：{String(args.cwd ?? "workspace")}</span></>
  }
  if (tool === "file.write") {
    return <><span>目标路径：{String(args.path ?? "")}</span><span>内容摘要：{summarize(String(args.content ?? ""), 180)}</span></>
  }
  if (tool === "file.read") return <span>读取路径：{String(args.path ?? "")}</span>
  if (tool === "clipboard.read") return <span>助手请求读取剪贴板，可能包含密码、令牌或隐私内容。</span>
  if (tool === "clipboard.write") return <span>写入剪贴板：{summarize(String(args.text ?? ""), 180)}</span>
  if (tool === "screenshot.capture") return <span>助手请求读取当前屏幕截图用于分析屏幕内容。</span>
  return <span>{summarize(JSON.stringify(args), 220)}</span>
}

function messageContentToText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content.map((block) => {
    if (block.type === "text") return block.text ?? ""
    if (block.type === "image_url") return "[图片输入]"
    if (block.type === "input_audio") return "[音频输入]"
    return JSON.stringify(block)
  }).filter(Boolean).join("\n")
}

function riskForTool(tool: string): string {
  if (tool === "shell.run") return "shell"
  if (tool === "file.write") return "workspace_write"
  if (tool === "file.read") return "workspace_read"
  if (tool === "clipboard.read") return "clipboard_read"
  if (tool === "clipboard.write") return "clipboard_write"
  if (tool === "screenshot.capture") return "screen_read"
  if (tool === "task.finish") return "safe"
  return "dangerous"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function summarize(text: string, max = 240): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}
