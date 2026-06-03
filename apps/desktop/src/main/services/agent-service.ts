import { clipboard, desktopCapturer } from "electron"
import { exec } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve, relative } from "node:path"
import { promisify } from "node:util"
import { AgentSession, EventBus, ToolRegistry, type AgentEvent, type AgentAction, type ToolResult, type ToolRuntime } from "@live2d-agent/agent-core"
import { OpenAiCompatibleAdapter } from "@live2d-agent/model-openai-compatible"
import { createDefaultTools, type RuntimeToolContext } from "@live2d-agent/tools"
import type { PermissionService } from "./permission-service.js"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"

const execAsync = promisify(exec)

export interface AgentServiceDeps {
  settings: SettingsService
  trace: TraceService
  permissions: PermissionService
}

export class AgentService implements ToolRuntime {
  private session?: AgentSession
  private events = new EventBus()
  private executors = new Map<string, (action: AgentAction) => Promise<ToolResult>>()

  constructor(private readonly deps: AgentServiceDeps) {
    this.reconfigure()
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.subscribe(listener)
  }

  reconfigure(): void {
    const settings = this.deps.settings.get()
    const definitions = createDefaultTools()
    const registry = new ToolRegistry()
    registry.register(...definitions)
    this.deps.permissions.setToolDefinitions(definitions)

    const model = new OpenAiCompatibleAdapter({
      baseUrl: settings.openaiBaseUrl.replace(/\/$/, ""),
      apiKey: settings.openaiApiKey ?? "",
      model: settings.openaiModel,
    })

    this.executors = this.createExecutors()
    this.session = new AgentSession(model, registry, this, this.deps.permissions, this.deps.trace, this.events)
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.session) this.reconfigure()
    await this.session?.runUserMessage(text)
  }

  async executeMany(actions: AgentAction[]): Promise<ToolResult[]> {
    return Promise.all(actions.map((action) => this.execute(action)))
  }

  private async execute(action: AgentAction): Promise<ToolResult> {
    const startedAt = Date.now()
    const executor = this.executors.get(action.tool)
    if (!executor) {
      return this.result(action, startedAt, false, `Unknown tool: ${action.tool}`, undefined, "UNKNOWN_TOOL")
    }

    try {
      return await executor(action)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.result(action, startedAt, false, message, undefined, "EXECUTION_ERROR")
    }
  }

  private createExecutors(): Map<string, (action: AgentAction) => Promise<ToolResult>> {
    const context = this.createRuntimeContext()
    return new Map([
      ["shell.run", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { command, cwd } = asRecord(args)
        const output = await context.runShell(String(command ?? ""), typeof cwd === "string" ? cwd : undefined)
        return this.result(action, startedAt, output.exitCode === 0, output.stdout || output.stderr, output)
      }],
      ["file.read", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { path } = asRecord(args)
        const content = await context.readFile(String(path ?? ""))
        return this.result(action, startedAt, true, content, { path })
      }],
      ["file.write", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { path, content } = asRecord(args)
        await context.writeFile(String(path ?? ""), String(content ?? ""))
        return this.result(action, startedAt, true, `Wrote ${path}`, { path })
      }],
      ["clipboard.read", async (action) => {
        const startedAt = Date.now()
        const text = await context.readClipboard()
        return this.result(action, startedAt, true, text, undefined)
      }],
      ["clipboard.write", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { text } = asRecord(args)
        await context.writeClipboard(String(text ?? ""))
        return this.result(action, startedAt, true, "Clipboard updated", undefined)
      }],
      ["screenshot.capture", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { displayId } = asRecord(args)
        const shot = await context.captureScreenshot(typeof displayId === "string" ? displayId : undefined)
        return this.result(action, startedAt, true, "Screenshot captured", shot)
      }],
      ["task.finish", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { summary, status } = asRecord(args)
        await context.finishTask(String(summary ?? "Done"), status === "failed" || status === "cancelled" ? status : "success")
        return this.result(action, startedAt, true, String(summary ?? "Done"), { status })
      }],
    ])
  }

  private createRuntimeContext(): RuntimeToolContext {
    return {
      runShell: async (command, cwd) => {
        const workspace = this.deps.settings.get().workspaceDir
        const safeCwd = cwd ? this.resolveWorkspacePath(cwd) : workspace
        const { stdout, stderr } = await execAsync(command, { cwd: safeCwd, timeout: 30_000, windowsHide: true })
        return { stdout, stderr, exitCode: stderr ? 1 : 0 }
      },
      readFile: async (path) => readFileSync(this.resolveWorkspacePath(path), "utf8"),
      writeFile: async (path, content) => {
        const target = this.resolveWorkspacePath(path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, "utf8")
      },
      readClipboard: async () => clipboard.readText(),
      writeClipboard: async (text) => clipboard.writeText(text),
      captureScreenshot: async (displayId) => {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } })
        const source = sources.find((item) => item.display_id === displayId) ?? sources[0]
        if (!source) throw new Error("No screen source available")
        return { imageBase64: source.thumbnail.toPNG().toString("base64"), mimeType: "image/png" }
      },
      finishTask: async () => undefined,
    }
  }

  private resolveWorkspacePath(path: string): string {
    const workspace = this.deps.settings.get().workspaceDir
    const target = resolve(workspace, path)
    if (relative(workspace, target).startsWith("..")) throw new Error("Path escapes workspace")
    return target
  }

  private result(action: AgentAction, startedAt: number, ok: boolean, content: string, data?: unknown, code = "TOOL_ERROR"): ToolResult {
    return {
      actionId: action.id,
      tool: action.tool,
      ok,
      content,
      data,
      error: ok ? undefined : { code, message: content, recoverable: true },
      startedAt,
      endedAt: Date.now(),
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}
