import type { AgentMessage, AudioContextAttachment } from "@live2d-agent/agent-core"
import {
  DEFAULT_PROMPT_PRESET_SETTINGS,
  type Emotion,
  type EmotionSettings,
  type PromptPresetSettings,
  type PublicSettings,
  type ReasoningEffort,
  type VoiceInputSettings,
} from "@live2d-agent/shared"

/* ------------------------------------------------------------------ */
/*  Shared interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface SettingsForm {
  mode: PublicSettings["mode"]
  openaiBaseUrl: string
  openaiModel: string
  reasoningEffort: ReasoningEffort
  apiKey: string
  workspaceDir: string
  live2dModelPath: string
  permissionMode: PublicSettings["permissions"]["mode"]
  windowWidth: string
  windowHeight: string
  promptPresets: PromptPresetSettings
  emotion: EmotionSettings
  voice: VoiceInputSettings
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
    reasoningEffort: "low",
    apiKey: "",
    workspaceDir: "",
    live2dModelPath: "",
    permissionMode: "permissive",
    windowWidth: "360",
    windowHeight: "720",
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
  }
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
  if (typeof message.content === "string") return message.content
  return message.content.map((block) => {
    if (block.type === "text") return block.text ?? ""
    if (block.type === "image_url") return "[图片输入]"
    if (block.type === "input_audio") return "[音频输入]"
    return JSON.stringify(block)
  }).filter(Boolean).join("\n")
}

export function riskForTool(tool: string): string {
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
