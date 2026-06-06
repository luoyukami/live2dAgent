import { clipboard, desktopCapturer } from "electron"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, relative } from "node:path"
import { AgentSession, EventBus, ToolRegistry, composeSystemPrompt, isEmotionPromptInjected, type AgentEvent, type AgentAction, type ToolResult, type ToolRuntime, type ToolArtifact } from "@live2d-agent/agent-core"
import { OpenAiCompatibleAdapter } from "@live2d-agent/model-openai-compatible"
import { createDefaultTools, type RuntimeToolContext } from "@live2d-agent/tools"
import type { ArtifactRef, AudioArtifactRef, AudioContextAttachment, DebugEmotionInfo, Emotion } from "@live2d-agent/shared"
import type { EmotionSource } from "@live2d-agent/agent-core"
import type { ArtifactStore } from "./artifact-store.js"
import type { PermissionService } from "./permission-service.js"
import type { PromptService } from "./prompt-service.js"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"

export interface AgentServiceDeps {
  settings: SettingsService
  trace: TraceService
  permissions: PermissionService
  artifacts: ArtifactStore
  prompts: PromptService
}

interface EmotionDebugState {
  lastEmotion: Emotion
  lastSource: EmotionSource
  lastRawTag?: string
  lastParseWarning?: string
}

export class AgentService implements ToolRuntime {
  private session?: AgentSession
  private events = new EventBus()
  private executors = new Map<string, (action: AgentAction) => Promise<ToolResult>>()
  private lastModelRequest?: unknown
  private lastModelResponse?: unknown
  private lastToolCall?: unknown
  private lastToolResult?: unknown
  private stepCount = 0
  private avatarState = "idle"
  private emotionState: EmotionDebugState = {
    lastEmotion: "neutral",
    lastSource: "fallback",
  }
  /**
   * Best-effort UI hint populated by renderer telemetry (VOICE_DEBUG_UPDATE).
   * The main process is the source of truth for audio artifact lifecycle;
   * this object is advisory only and must not drive control flow.
   */
  private voiceDebug = {
    lastRecordingState: "idle" as "idle" | "recording" | "finished" | "cancelled" | "error",
    lastAudioArtifact: undefined as { id: string; path: string; mimeType: string; size: number; durationMs: number; createdAt: number } | undefined,
    lastSentFormat: undefined as "wav" | "mp3" | undefined,
    lastError: undefined as string | undefined,
  }

  constructor(private readonly deps: AgentServiceDeps) {
    this.events.subscribe((event) => this.captureEvent(event))
    this.reconfigure()
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.subscribe(listener)
  }

  reconfigure(): void {
    const settings = this.deps.settings.get()
    const definitions = this.deps.prompts.applyToolOverrides(createDefaultTools())
    const registry = new ToolRegistry()
    registry.register(...definitions)
    this.deps.permissions.setToolDefinitions(definitions)

    const model = new OpenAiCompatibleAdapter({
      baseUrl: settings.openaiBaseUrl.replace(/\/$/, ""),
      apiKey: settings.openaiApiKey ?? "",
      model: settings.openaiModel,
      reasoningEffort: settings.reasoningEffort,
      systemPromptProvider: () => this.composeActiveSystemPrompt(),
      onModelRequest: (request) => { this.lastModelRequest = request },
      onModelResponse: (response) => { this.lastModelResponse = response },
      artifactReader: {
        readArtifact: (ref) => this.deps.artifacts.readArtifact(ref),
      },
      audioInputEnabled: settings.voice.audioInputEnabled,
      audioReader: {
        // Buffer extends Uint8Array; explicit cast keeps the adapter API
        // platform-agnostic.
        readAudio: (ref) => this.deps.artifacts.readArtifact(ref) as Uint8Array,
      },
      onAudioSent: (info) => {
        this.deps.trace.append({
          type: "audio.sent_to_model",
          attachmentId: info.attachmentId,
          format: info.format,
          durationMs: info.durationMs,
          bytes: info.bytes,
        })
        this.voiceDebug.lastSentFormat = info.format
      },
    })

    this.executors = this.createExecutors()
    this.session = new AgentSession(model, registry, this, this.deps.permissions, this.deps.trace, this.events, {
      maxSteps: settings.agent.maxSteps,
      emotion: settings.emotion,
    })
  }

  /**
   * Build the system prompt that will be sent to the model:
   *  base user-defined prompt
   *  + emotion tag instructions (when settings allow it)
   *
   * The PromptService returns the raw user-editable prompt; we layer the
   * emotion block on top of it. We do NOT cache the composed prompt inside
   * the PromptService — that keeps the user-facing system.md file
   * uncluttered by emotion-related content.
   */
  private composeActiveSystemPrompt(): string {
    const base = this.deps.prompts.getSystemPrompt()
    const settings = this.deps.settings.get()
    return composeSystemPrompt(base, settings.emotion)
  }

  async sendUserMessage(input: string | { text: string; attachments?: AudioContextAttachment[] }): Promise<void> {
    if (!this.deps.settings.get().openaiApiKey) {
      this.emit({
        type: "message.added",
        message: {
          id: `msg_sys_${Date.now()}`,
          role: "assistant",
          content: "API Key 未配置，请在设置中填写 API Key 后再使用。",
          createdAt: Date.now(),
          extra: { error: { code: "NO_API_KEY", message: "API Key not configured", recoverable: true } },
        },
      })
      return
    }
    if (!this.session) this.reconfigure()
    await this.session?.runUserMessage(input)
  }

  async executeMany(actions: AgentAction[]): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    for (const action of actions) {
      results.push(await this.execute(action))
    }
    return results
  }

  async runManualAction(tool: string, args: unknown): Promise<void> {
    const action: AgentAction = {
      id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      tool,
      args,
      source: "user",
      createdAt: Date.now(),
    }

    const decision = await this.deps.permissions.check([action])
    if (decision.status === "denied") {
      const result = this.result(action, Date.now(), false, decision.reason ?? "Manual action denied", undefined, "ACTION_NOT_APPROVED")
      this.emit({ type: "tool.error", result })
      return
    }

    for (const approved of decision.actions) this.emit({ type: "tool.started", action: approved })
    const results = await this.executeMany(decision.actions)
    for (const result of results) {
      this.emit(result.ok ? { type: "tool.finished", result } : { type: "tool.error", result })
    }
  }

  getDebugState(): {
    lastModelRequest?: unknown
    lastModelResponse?: unknown
    lastToolCall?: unknown
    lastToolResult?: unknown
    stepCount: number
    avatarState: string
    emotion: DebugEmotionInfo
    composedSystemPrompt: string
    rawSystemPrompt: string
    voice?: {
      enabled: boolean
      audioInputEnabled: boolean
      preferredFormat: "wav" | "mp3"
      maxDurationMs: number
      hotkey: string
      lastRecordingState: "idle" | "recording" | "finished" | "cancelled" | "error"
      lastAudioArtifact?: {
        id: string
        path: string
        mimeType: string
        size: number
        durationMs: number
        createdAt: number
      }
      lastSentFormat?: "wav" | "mp3"
      lastError?: string
    }
  } {
    const settings = this.deps.settings.get()
    const composedPrompt = this.composeActiveSystemPrompt()
    return {
      lastModelRequest: this.lastModelRequest,
      lastModelResponse: this.lastModelResponse,
      lastToolCall: this.lastToolCall,
      lastToolResult: this.lastToolResult,
      stepCount: this.stepCount,
      avatarState: this.avatarState,
      emotion: {
        enabled: settings.emotion.enabled,
        injectPrompt: settings.emotion.injectPrompt,
        defaultEmotion: settings.emotion.defaultEmotion,
        lastEmotion: this.emotionState.lastEmotion,
        lastSource: this.emotionState.lastSource,
        lastRawTag: this.emotionState.lastRawTag,
        lastParseWarning: this.emotionState.lastParseWarning,
        promptInjected: isEmotionPromptInjected(composedPrompt),
      },
      composedSystemPrompt: composedPrompt,
      rawSystemPrompt: this.deps.prompts.getSystemPrompt(),
      voice: {
        enabled: settings.voice.enabled,
        audioInputEnabled: settings.voice.audioInputEnabled,
        preferredFormat: settings.voice.preferredFormat,
        maxDurationMs: settings.voice.maxDurationMs,
        hotkey: settings.voice.pushToTalkHotkey,
        lastRecordingState: this.voiceDebug.lastRecordingState,
        lastAudioArtifact: this.voiceDebug.lastAudioArtifact,
        lastSentFormat: this.voiceDebug.lastSentFormat,
        lastError: this.voiceDebug.lastError,
      },
    }
  }

  /**
   * Merge renderer-reported voice debug telemetry into the local state.
   *
   * The incoming values are untrusted UI hints (the renderer does not own
   * the audio artifact lifecycle). Real artifact creation is tracked via
   * `AUDIO_SAVE_RECORDING` → `setVoiceDebug` called from the main process.
   * Treat these as best-effort display information only.
   */
  setVoiceDebug(input: Partial<{
    lastRecordingState: "idle" | "recording" | "finished" | "cancelled" | "error"
    lastAudioArtifact: { id: string; path: string; mimeType: string; size: number; durationMs: number; createdAt: number }
    lastSentFormat: "wav" | "mp3"
    lastError: string
  }>): void {
    if (input.lastRecordingState !== undefined) this.voiceDebug.lastRecordingState = input.lastRecordingState
    if (input.lastAudioArtifact !== undefined) this.voiceDebug.lastAudioArtifact = input.lastAudioArtifact
    if (input.lastSentFormat !== undefined) this.voiceDebug.lastSentFormat = input.lastSentFormat
    if (input.lastError !== undefined) this.voiceDebug.lastError = input.lastError
  }

  emitEvent(event: AgentEvent): void {
    this.deps.trace.append(event)
    this.events.emit(event)
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
        if (!source) throw new Error("截图失败：未找到可用的屏幕源，请检查是否有显示器连接")
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

  private emit(event: AgentEvent): void {
    this.deps.trace.append(event)
    this.events.emit(event)
  }

  private captureEvent(event: AgentEvent): void {
    if (event.type === "agent.thinking") this.stepCount += 1
    this.avatarState = event.type === "agent.thinking"
      ? "thinking"
      : event.type === "approval.pending"
        ? "waiting_approval"
        : event.type === "tool.started"
          ? "running_tool"
          : event.type === "tool.finished"
            ? "success"
            : event.type === "tool.error" || event.type === "agent.error"
              ? "error"
              : event.type === "agent.idle"
                ? "idle"
                : this.avatarState
    if (event.type === "tool.started") this.lastToolCall = event.action
    if (event.type === "tool.finished" || event.type === "tool.error") this.lastToolResult = event.result
    if (event.type === "emotion.set") {
      this.emotionState = {
        lastEmotion: event.emotion,
        lastSource: event.source,
        lastRawTag: undefined,
        lastParseWarning: undefined,
      }
    }
    if (event.type === "message.added" && event.message.metadata) {
      const meta = event.message.metadata
      if (meta.emotion && meta.emotionSource) {
        this.emotionState = {
          lastEmotion: meta.emotion,
          lastSource: meta.emotionSource,
          lastRawTag: meta.rawEmotionTag,
          lastParseWarning: meta.parseWarning,
        }
      }
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
    const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd,
      windowsHide: true,
    })
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
