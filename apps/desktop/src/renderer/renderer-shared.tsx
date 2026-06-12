import type { Dispatch, SetStateAction } from "react"
import type { AgentMessage, AudioContextAttachment } from "@live2d-agent/agent-core"
import {
  DEFAULT_PROMPT_PRESET_SETTINGS,
  DEFAULT_LOCAL_TTS_SETTINGS,
  DEFAULT_COMPANION_WATCH_SETTINGS,
  DEFAULT_MCP_SETTINGS,
  type Emotion,
  type EmotionSettings,
  type PromptPresetSettings,
  type PublicSettings,
  type ReasoningEffort,
  type VoiceInputSettings,
  type LocalTtsSettings,
  type CompanionWatchSettings,
  type McpSettings,
} from "@live2d-agent/shared"

/* ------------------------------------------------------------------ */
/*  Shared interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface SettingsForm {
  mode: PublicSettings["mode"]
  openaiBaseUrl: string
  openaiModel: string
  openaiMultimodalModel: string
  reasoningEffort: ReasoningEffort
  apiKey: string
  workspaceDir: string
  live2dModelPath: string
  permissionMode: PublicSettings["permissions"]["mode"]
  windowWidth: string
  windowHeight: string
  panelWidth: string
  panelHeight: string
  promptPresets: PromptPresetSettings
  emotion: EmotionSettings
  voice: VoiceInputSettings
  companionWatch: CompanionWatchSettings
  mcp: McpSettings
  tts: {
    enabled: boolean
    apiBaseUrl: string
    selectedVoiceId: string
    voiceDisplayNames: Record<string, string>
    ttsMode: "standard" | "emotion_enhanced"
    emotionControlMode: "default_mapping" | "llm_controlled"
    speed: number
    seed: number
    audioOutputDir: string
    autoGenerateOnAssistantMessage: boolean
    autoPlayAfterGenerate: boolean
    requestTimeoutMs: number
  }
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const HOTKEY_HINT =
  "v0 快捷键仅在窗口聚焦时生效。当前实现固定为 Ctrl/Cmd + Alt + V，设置中保存的字符串仅用于显示和未来扩展。"

export const EMOTION_IDLE_REVERT_MS = 20_000
export const IDLE_EMOTION: Emotion = "neutral"

export const RISK_TEXT: Record<string, string> = {
  safe: "安全操作",
  workspace_read: "读取工作区文件",
  workspace_write: "写入工作区文件，需要确认",
  screen_read: "读取屏幕截图，可能包含隐私信息",
  clipboard_read: "读取剪贴板，可能包含敏感信息",
  clipboard_write: "修改剪贴板内容",
  shell: "执行命令，可能修改文件或运行程序",
  dangerous: "高风险操作，默认拒绝",
}

/* ------------------------------------------------------------------ */
/*  Pure helper functions                                              */
/* ------------------------------------------------------------------ */

export function hasVisibleText(message: AgentMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0
  return Array.isArray(message.content) && message.content.length > 0
}

export function shouldRenderAddedMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") return true
  return hasVisibleText(message)
}

export function normalizeFormDimension(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.round(Math.min(4000, Math.max(200, parsed)))
}

export function mergeAddedMessage(items: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const existingIndex = items.findIndex((item) => item.id === message.id)

  if (!shouldRenderAddedMessage(message)) {
    return existingIndex >= 0 ? items.filter((item) => item.id !== message.id) : items
  }

  if (existingIndex < 0) return [...items, message]

  return items.map((item, index) => {
    if (index !== existingIndex) return item
    return {
      ...item,
      ...message,
      content: hasVisibleText(message) ? message.content : item.content,
    }
  })
}

export function defaultForm(): SettingsForm {
  return {
    mode: "confirm",
    openaiBaseUrl: "",
    openaiModel: "",
    openaiMultimodalModel: "",
    reasoningEffort: "low",
    apiKey: "",
    workspaceDir: "",
    live2dModelPath: "",
    permissionMode: "permissive",
    windowWidth: "360",
    windowHeight: "720",
    panelWidth: "460",
    panelHeight: "760",
    promptPresets: { ...DEFAULT_PROMPT_PRESET_SETTINGS },
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
    companionWatch: { ...DEFAULT_COMPANION_WATCH_SETTINGS },
    mcp: { ...DEFAULT_MCP_SETTINGS, servers: {}, search: { ...DEFAULT_MCP_SETTINGS.search } },
    tts: {
      enabled: DEFAULT_LOCAL_TTS_SETTINGS.enabled,
      apiBaseUrl: DEFAULT_LOCAL_TTS_SETTINGS.apiBaseUrl,
      selectedVoiceId: DEFAULT_LOCAL_TTS_SETTINGS.selectedVoiceId ?? "",
      voiceDisplayNames: { ...DEFAULT_LOCAL_TTS_SETTINGS.voiceDisplayNames },
      ttsMode: DEFAULT_LOCAL_TTS_SETTINGS.ttsMode,
      emotionControlMode: DEFAULT_LOCAL_TTS_SETTINGS.emotionControlMode,
      speed: DEFAULT_LOCAL_TTS_SETTINGS.speed,
      seed: DEFAULT_LOCAL_TTS_SETTINGS.seed,
      audioOutputDir: DEFAULT_LOCAL_TTS_SETTINGS.audioOutputDir,
      autoGenerateOnAssistantMessage: DEFAULT_LOCAL_TTS_SETTINGS.autoGenerateOnAssistantMessage,
      autoPlayAfterGenerate: DEFAULT_LOCAL_TTS_SETTINGS.autoPlayAfterGenerate,
      requestTimeoutMs: DEFAULT_LOCAL_TTS_SETTINGS.requestTimeoutMs,
    },
  }
}

export function buildCompanionWatchPatch(
  form: SettingsForm,
  settings: PublicSettings | null,
): Record<string, unknown> | undefined {
  const current = settings?.companionWatch
  const patch: Record<string, unknown> = {}
  if (form.companionWatch.attachScreenshotOnUserMessage !== (current?.attachScreenshotOnUserMessage ?? DEFAULT_COMPANION_WATCH_SETTINGS.attachScreenshotOnUserMessage)) {
    patch.attachScreenshotOnUserMessage = form.companionWatch.attachScreenshotOnUserMessage
  }
  if (form.companionWatch.proactiveEnabled !== (current?.proactiveEnabled ?? DEFAULT_COMPANION_WATCH_SETTINGS.proactiveEnabled)) {
    patch.proactiveEnabled = form.companionWatch.proactiveEnabled
  }
  if (form.companionWatch.proactiveInterval !== (current?.proactiveInterval ?? DEFAULT_COMPANION_WATCH_SETTINGS.proactiveInterval)) {
    patch.proactiveInterval = form.companionWatch.proactiveInterval
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

export function McpSettingsSection({ form, setForm }: { form: SettingsForm; setForm: Dispatch<SetStateAction<SettingsForm>> }): JSX.Element {
  return (
    <div className="settings-card">
      <h3 className="settings-card-title">MCP 与联网搜索</h3>
      <div className="settings-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.mcp.enabled}
            onChange={(e) => setForm((f) => ({ ...f, mcp: { ...f.mcp, enabled: e.target.checked } }))}
          />
          <span>启用 MCP 工具</span>
        </label>
        <small className="settings-hint">默认开启。启用后会读取下方配置文件，并注册内置 keyless 联网搜索工具或自定义 MCP server。</small>
      </div>

      <div className="settings-group">
        <label>MCP 配置文件（JSON）</label>
        <input
          value={form.mcp.configPath}
          onChange={(e) => setForm((f) => ({ ...f, mcp: { ...f.mcp, configPath: e.target.value } }))}
          placeholder="例如 C:\\Users\\you\\mcp.json，支持 { mcpServers: { ... } }"
        />
        <small className="settings-hint">支持 stdio、sse、streamable_http/http server；密钥建议写成 $ENV_NAME 或 ${"${ENV_NAME}"}。</small>
      </div>

      <div className="settings-group">
        <label>默认超时（毫秒）</label>
        <input
          type="number"
          min={1000}
          max={600000}
          step={1000}
          value={form.mcp.defaultTimeoutMs}
          onChange={(e) => setForm((f) => ({ ...f, mcp: { ...f.mcp, defaultTimeoutMs: Number(e.target.value) || 30000 } }))}
        />
      </div>

      <div className="settings-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.mcp.search.enabled}
            disabled={!form.mcp.enabled}
            onChange={(e) => setForm((f) => ({ ...f, mcp: { ...f.mcp, search: { ...f.mcp.search, enabled: e.target.checked } } }))}
          />
          <span>启用联网搜索工具（Parallel keyless）</span>
        </label>
        <small className="settings-hint">默认走 Parallel Search MCP 匿名模式；填写 Parallel API Key 或设置 PARALLEL_API_KEY 可提升限额。</small>
      </div>

      <div className="settings-group">
        <label>搜索 Provider</label>
        <select
          value={form.mcp.search.provider}
          disabled={!form.mcp.enabled || !form.mcp.search.enabled}
          onChange={(e) => setForm((f) => ({ ...f, mcp: { ...f.mcp, search: { ...f.mcp.search, provider: e.target.value as "parallel" | "brave" } } }))}
        >
          <option value="parallel">Parallel Search MCP（默认，无 key 可用）</option>
          <option value="brave">Brave Search MCP（需要 API Key）</option>
        </select>
      </div>

      <div className="settings-group">
        <label>{form.mcp.search.provider === "parallel" ? "Parallel API Key（可选）" : "Brave Search API Key"}</label>
        <input
          type="password"
          value={form.mcp.search.provider === "parallel" ? (form.mcp.search.parallelApiKey ?? "") : (form.mcp.search.braveApiKey ?? "")}
          disabled={!form.mcp.enabled || !form.mcp.search.enabled}
          onChange={(e) => setForm((f) => ({
            ...f,
            mcp: {
              ...f.mcp,
              search: form.mcp.search.provider === "parallel"
                ? { ...f.mcp.search, parallelApiKey: e.target.value }
                : { ...f.mcp.search, braveApiKey: e.target.value },
            },
          }))}
          placeholder={form.mcp.search.provider === "parallel" ? "可留空走 keyless 匿名模式" : "Brave 模式必须填写"}
        />
      </div>
    </div>
  )
}

export function CompanionWatchSettingsSection({
  form,
  setForm,
}: {
  form: SettingsForm
  setForm: Dispatch<SetStateAction<SettingsForm>>
}): JSX.Element {
  return (
    <div className="settings-card">
      <h3 className="settings-card-title">陪看模式</h3>

      <div className="settings-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.companionWatch.attachScreenshotOnUserMessage}
            onChange={(e) => setForm((f) => ({
              ...f,
              companionWatch: { ...f.companionWatch, attachScreenshotOnUserMessage: e.target.checked },
            }))}
          />
          <span>常驻发送截屏</span>
        </label>
        <small className="settings-hint">
          开启后，用户发送的每条消息都会自动附带一张当前屏幕截图，让助手结合屏幕内容回答。
        </small>
      </div>

      <div className="settings-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.companionWatch.proactiveEnabled}
            onChange={(e) => setForm((f) => ({
              ...f,
              companionWatch: { ...f.companionWatch, proactiveEnabled: e.target.checked },
            }))}
          />
          <span>助手主动模式</span>
        </label>
        <small className="settings-hint">
          开启后会定时截屏，并以系统指令形式让助手主动观察屏幕、找话题聊天。
        </small>
      </div>

      <div className="settings-group">
        <label>主动观察间隔</label>
        <select
          value={form.companionWatch.proactiveInterval}
          disabled={!form.companionWatch.proactiveEnabled}
          onChange={(e) => setForm((f) => ({
            ...f,
            companionWatch: {
              ...f.companionWatch,
              proactiveInterval: e.target.value as CompanionWatchSettings["proactiveInterval"],
            },
          }))}
        >
          <option value="30s">30 秒</option>
          <option value="1m">1 分钟</option>
          <option value="2m">2 分钟</option>
          <option value="random">随机（30 秒–2 分钟）</option>
        </select>
        <small className="settings-hint">
          主动模式会把截图作为当前屏幕上下文发送给助手；请避免在屏幕上显示敏感信息。
        </small>
      </div>
    </div>
  )
}

export function formatAttachmentLabel(att: AudioContextAttachment): string {
  const seconds = (att.durationMs / 1000).toFixed(1)
  return `录音 ${seconds}s · ${att.mimeType.replace("audio/", "")}`
}

export function formatAttachmentSubLabel(att: AudioContextAttachment): string {
  const sizeKb = (att.artifact.size / 1024).toFixed(1)
  return `${att.artifact.path.split(/[\\/]/).pop()} · ${sizeKb} KB`
}

export function messageContentToText(message: AgentMessage): string {
  let text: string
  if (typeof message.content === "string") {
    text = message.content
  } else {
    text = message.content.map((block) => {
      if (block.type === "text") return block.text ?? ""
      if (block.type === "image_url") return "[图片输入]"
      if (block.type === "input_audio") return "[音频输入]"
      return JSON.stringify(block)
    }).filter(Boolean).join("\n")
  }
  // Strip control tags for display
  text = text.replace(/(?:\r?\n)?[ \t]*<emotion\s+value\s*=\s*["']([a-z_]+)["']\s*\/>[ \t]*(?:\r?\n)?[ \t]*$/gi, "")
  text = text.replace(/\[\[TTS_INSTRUCTION:[\s\S]*?\]\]/g, "")
  return text.replace(/(?:[ \t]*\r?\n)+[ \t]*$/u, "").replace(/[ \t]+$/u, "").trim()
}

export function riskForTool(tool: string): string {
  if (tool.startsWith("mcp__")) {
    return /__(delete|remove|write|update|create|exec|shell|command|run|spawn|apply|mutate)/i.test(tool)
      ? "shell"
      : "workspace_read"
  }
  if (tool === "shell.run") return "shell"
  if (tool === "file.write") return "workspace_write"
  if (tool === "file.read") return "workspace_read"
  if (tool === "clipboard.read") return "clipboard_read"
  if (tool === "clipboard.write") return "clipboard_write"
  if (tool === "screenshot.capture") return "screen_read"
  if (tool === "task.finish") return "safe"
  return "dangerous"
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function summarize(text: string, max = 240): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function renderActionSummary(tool: string, args: Record<string, unknown>): JSX.Element {
  if (tool.startsWith("mcp__")) {
    const [, server, ...rest] = tool.split("__")
    return <><span>MCP：{server}/{rest.join("__")}</span><span>参数：{summarize(JSON.stringify(args), 300)}</span></>
  }
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
