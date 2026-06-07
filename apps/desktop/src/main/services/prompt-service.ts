import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolDefinition } from "@live2d-agent/agent-core"

const LEGACY_DEFAULT_SYSTEM_PROMPT = `You are Live2D Agent, a local desktop assistant.

Be concise, ask before risky actions, and use tools when they help. Keep file and shell work inside the configured workspace.`

const DEFAULT_SYSTEM_PROMPT = `You are Live2D Agent, a local desktop assistant.

Be concise, friendly, and answer ordinary conversation directly in assistant text.

Tool policy:
- Do not use tools for greetings, casual chat, or questions you can answer from the conversation.
- Use tools only when they are necessary to complete the user's explicit request.
- Use clipboard tools only when the user explicitly asks to read or write the clipboard.
- Use task.finish only when the user has explicitly delegated a task that should be marked finished; never use it for casual chat.
- Ask before risky actions and keep file and shell work inside the configured workspace.`

type ToolOverrides = Record<string, { description?: string } | string>

export class PromptService {
  private readonly dir: string
  private readonly systemFile: string
  private readonly overridesFile: string
  private systemPrompt = DEFAULT_SYSTEM_PROMPT
  private overrides: ToolOverrides = {}
  private error?: string

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, "dev-prompts")
    this.systemFile = join(this.dir, "system.md")
    this.overridesFile = join(this.dir, "tool-overrides.json")
    this.ensureFiles()
    this.reload()
  }

  reload(): void {
    this.error = undefined
    try {
      this.ensureFiles()
      this.systemPrompt = migrateLegacyDefault(readFileSync(this.systemFile, "utf8"))
    } catch (error) {
      this.error = `读取 system.md 失败：${messageOf(error)}`
      this.systemPrompt = DEFAULT_SYSTEM_PROMPT
    }

    try {
      const text = readFileSync(this.overridesFile, "utf8").trim()
      this.overrides = text ? JSON.parse(text) as ToolOverrides : {}
    } catch (error) {
      const msg = `解析 tool-overrides.json 失败：${messageOf(error)}`
      this.error = this.error ? `${this.error}\n${msg}` : msg
      this.overrides = {}
    }
  }

  getDir(): string {
    return this.dir
  }

  getSystemPrompt(): string {
    // Dev hot reload: read each model request, but keep last good state on error.
    try {
      this.systemPrompt = migrateLegacyDefault(readFileSync(this.systemFile, "utf8"))
      return this.systemPrompt
    } catch (error) {
      this.error = `读取 system.md 失败：${messageOf(error)}`
      return this.systemPrompt
    }
  }

  getPreview(max = 2000): string {
    const prompt = this.getSystemPrompt()
    return prompt.length <= max ? prompt : `${prompt.slice(0, max)}…`
  }

  getError(): string | undefined {
    return this.error
  }

  applyToolOverrides(definitions: ToolDefinition[]): ToolDefinition[] {
    this.reloadOverridesOnly()
    return definitions.map((definition) => {
      const override = this.overrides[definition.name]
      const description = typeof override === "string" ? override : override?.description
      return description ? { ...definition, description } : definition
    })
  }

  private reloadOverridesOnly(): void {
    try {
      const text = readFileSync(this.overridesFile, "utf8").trim()
      this.overrides = text ? JSON.parse(text) as ToolOverrides : {}
    } catch (error) {
      const msg = `解析 tool-overrides.json 失败：${messageOf(error)}`
      this.error = this.error ? `${this.error}\n${msg}` : msg
      this.overrides = {}
    }
  }

  private ensureFiles(): void {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.systemFile)) writeFileSync(this.systemFile, DEFAULT_SYSTEM_PROMPT, "utf8")
    if (!existsSync(this.overridesFile)) writeFileSync(this.overridesFile, "{}\n", "utf8")
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function migrateLegacyDefault(prompt: string): string {
  return prompt.trim() === LEGACY_DEFAULT_SYSTEM_PROMPT ? DEFAULT_SYSTEM_PROMPT : prompt
}
