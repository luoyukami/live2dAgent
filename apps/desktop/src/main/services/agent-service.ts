import { clipboard, desktopCapturer } from "electron"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, relative } from "node:path"
import { AgentSession, EventBus, ToolRegistry, type AgentEvent, type AgentAction, type ToolResult, type ToolRuntime, type ToolArtifact } from "@live2d-agent/agent-core"
import { OpenAiCompatibleAdapter } from "@live2d-agent/model-openai-compatible"
import { createDefaultTools, type RuntimeToolContext } from "@live2d-agent/tools"
import type { ArtifactRef } from "@live2d-agent/shared"
import type { ArtifactStore } from "./artifact-store.js"
import type { PermissionService } from "./permission-service.js"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"

export interface AgentServiceDeps {
  settings: SettingsService
  trace: TraceService
  permissions: PermissionService
  artifacts: ArtifactStore
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
    const results: ToolResult[] = []
    for (const action of actions) {
      results.push(await this.execute(action))
    }
    return results
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
        return this.result(action, startedAt, output.exitCode === 0, formatShellOutput(output), output)
      }],
      ["file.read", async (action) => {
        const startedAt = Date.now()
        const args = action.args
        const { path } = asRecord(args)
        const content = await context.readFile(String(path ?? ""))
        return this.result(action, startedAt, true, truncate(content), { path })
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
        const ref = this.deps.artifacts.saveArtifact({
          kind: "screenshot",
          mimeType: shot.mimeType,
          data: shot.data,
          ext: ".png",
        })
        const artifact: ToolArtifact = { id: ref.id, type: "screenshot", mimeType: ref.mimeType, path: ref.path, artifact: ref }
        return this.result(action, startedAt, true, "Screenshot captured", { mimeType: shot.mimeType, artifact: ref }, [artifact])
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
        const safeCwd = cwd ? this.resolveExistingWorkspacePath(cwd) : realpathSync(workspace)
        return runShellCommand(command, safeCwd)
      },
      readFile: async (path) => readFileSync(this.resolveExistingWorkspacePath(path), "utf8"),
      writeFile: async (path, content) => {
        const target = this.resolveNewWorkspacePath(path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, "utf8")
      },
      readClipboard: async () => clipboard.readText(),
      writeClipboard: async (text) => clipboard.writeText(text),
      captureScreenshot: async (displayId) => {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } })
        const source = sources.find((item) => item.display_id === displayId) ?? sources[0]
        if (!source) throw new Error("No screen source available")
        const pngBuffer = source.thumbnail.toPNG()
        return { data: pngBuffer, mimeType: "image/png" }
      },
      finishTask: async () => undefined,
    }
  }

  private resolveWorkspacePath(path: string): string {
    const workspace = this.deps.settings.get().workspaceDir
    const target = resolve(workspace, path)
    if (isOutside(workspace, target)) throw new Error("Path escapes workspace")
    return target
  }

  private resolveExistingWorkspacePath(path: string): string {
    const workspace = realpathSync(this.deps.settings.get().workspaceDir)
    const target = realpathSync(this.resolveWorkspacePath(path))
    if (isOutside(workspace, target)) throw new Error("Path escapes workspace")
    return target
  }

  private resolveNewWorkspacePath(path: string): string {
    const target = this.resolveWorkspacePath(path)
    const workspace = realpathSync(this.deps.settings.get().workspaceDir)
    if (existsSync(target)) {
      const realTarget = realpathSync(target)
      if (isOutside(workspace, realTarget)) throw new Error("Path escapes workspace")
      return target
    }
    const parent = dirname(target)
    const existingAncestor = findExistingAncestor(parent, workspace)
    const realAncestor = realpathSync(existingAncestor)
    if (isOutside(workspace, realAncestor)) throw new Error("Path escapes workspace")
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    return target
  }

  private result(action: AgentAction, startedAt: number, ok: boolean, content: string, data?: unknown, codeOrArtifacts?: string | ToolArtifact[]): ToolResult {
    const isCode = typeof codeOrArtifacts === "string"
    const artifacts = !ok || isCode ? undefined : (codeOrArtifacts as ToolArtifact[] | undefined)
    return {
      actionId: action.id,
      providerToolCallId: action.providerToolCallId,
      tool: action.tool,
      ok,
      content,
      data,
      error: ok ? undefined : { code: isCode ? codeOrArtifacts : "TOOL_ERROR", message: content, recoverable: true },
      artifacts,
      startedAt,
      endedAt: Date.now(),
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function isOutside(parent: string, target: string): boolean {
  const rel = relative(parent, target)
  return rel !== "" && (rel.startsWith("..") || isAbsolute(rel))
}

function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    const stdout = createLimitedCollector()
    const stderr = createLimitedCollector()
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcessTree(child.pid)
      resolve({ stdout: stdout.text(), stderr: `${stderr.text()}\nCommand timed out after 30000ms`, exitCode: 124 })
    }, 30_000)

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk))
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: stdout.text(), stderr: truncate(error.message), exitCode: 1 })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code ?? 1 })
    })
  })
}

function formatShellOutput(output: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = []
  if (output.stdout) parts.push(`STDOUT:\n${output.stdout}`)
  if (output.stderr) parts.push(`STDERR:\n${output.stderr}`)
  parts.push(`Exit code: ${output.exitCode}`)
  return parts.join("\n\n")
}

function truncate(content: string, maxChars = 12_000): string {
  const edgeChars = Math.floor(maxChars / 2)
  if (content.length <= maxChars) return content
  return `${content.slice(0, edgeChars)}\n\n[... truncated ${content.length - maxChars} chars ...]\n\n${content.slice(-edgeChars)}`
}

function findExistingAncestor(path: string, workspace: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current || isOutside(workspace, parent)) throw new Error("Path escapes workspace")
    current = parent
  }
  return current
}

function createLimitedCollector(maxBytes = 64 * 1024): { append(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncatedBytes = 0

  return {
    append(chunk) {
      if (bytes >= maxBytes) {
        truncatedBytes += chunk.length
        return
      }
      const remaining = maxBytes - bytes
      const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(next)
      bytes += next.length
      truncatedBytes += chunk.length - next.length
    },
    text() {
      const content = Buffer.concat(chunks).toString("utf8")
      return truncatedBytes > 0 ? `${content}\n\n[... truncated ${truncatedBytes} bytes ...]` : content
    },
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true })
    return
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // Process may already have exited.
  }
}
