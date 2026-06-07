import { clipboard, desktopCapturer } from "electron"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, relative } from "node:path"
import { AgentSession, AssistantRuntime, ContextManager, ConversationManager, DefaultProviderRuntimeRegistry, EventBus, RunController, ToolRegistry, WsSessionManager, composeSystemPrompt, isEmotionPromptInjected, ToolResultLimiter, type AgentEvent, type AgentAction, type AgentRuntimeEvent, type ArtifactWriter, type ToolResult, type ToolRuntime, type ToolArtifact, type ConversationStore, type ContextBuilder, type ToolManager, type ToolValidationResult, type CanonicalToolDefinition, type ModelToolCall, type ValidatedToolCall, type CanonicalToolResult, type CanonicalCreateInput, type CanonicalToolContinuationInput, type AssistantRuntimeEvent, type ProviderRuntime, type ModelMessage, type ModelContentPart } from "@live2d-agent/agent-core"
import { OpenAiCompatibleAdapter, OpenAiCompatibleWsClient, MimoWsRuntime } from "@live2d-agent/model-openai-compatible"
import { createDefaultTools, type RuntimeToolContext } from "@live2d-agent/tools"
import type { ArtifactRef, AudioArtifactRef, AudioContextAttachment, DebugEmotionInfo, Emotion } from "@live2d-agent/shared"
import type { EmotionSource } from "@live2d-agent/agent-core"
import type { ArtifactStore } from "./artifact-store.js"
import type { PermissionService } from "./permission-service.js"
import type { PromptService } from "./prompt-service.js"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"
import { AgentRuntimeEventBridge } from "../agent-runtime-event-bridge.js"

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
  private activeConversationId?: string
  private conversationManager?: ConversationManager
  private wsSessionManager?: WsSessionManager
  private runController?: RunController
  private session?: AgentSession
  /** New AssistantRuntime (Phase 3/4) — used when runtimeMode === "ws" */
  private assistantRuntime?: AssistantRuntime
  /** Bridge for AssistantRuntimeEvent → AgentEvent conversion */
  private bridge = new AgentRuntimeEventBridge()
  /** Unsubscribe from AssistantRuntime events */
  private assistantRuntimeUnsub?: () => void
  /** Unsubscribe from bridge events */
  private bridgeUnsub?: () => void
  private runtimeMode: "ws" | "http-legacy" = "ws"
  private events = new EventBus()
  private executors = new Map<string, (action: AgentAction) => Promise<ToolResult>>()
  private lastModelRequest?: unknown
  private lastModelResponse?: unknown
  private lastToolCall?: unknown
  private lastToolResult?: unknown
  private runtimeToolCalls = new Map<string, { name: string; args: unknown }>()
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
    // Dispose old runtimes
    this.runController?.dispose()
    this.wsSessionManager?.dispose()
    this.assistantRuntimeUnsub?.()
    this.bridgeUnsub?.()
    this.bridge.clear()
    this.assistantRuntime = undefined
    this.session = undefined

    const settings = this.deps.settings.get()
    this.runtimeMode = settings.agent.runtimeMode ?? "ws"

    const definitions = this.deps.prompts.applyToolOverrides(createDefaultTools())
    const registry = new ToolRegistry()
    registry.register(...definitions)
    this.deps.permissions.setToolDefinitions(definitions)

    this.executors = this.createExecutors()
    this.conversationManager = new ConversationManager()
    this.activeConversationId = this.conversationManager.createConversation("Default").id

    if (this.runtimeMode === "http-legacy") {
      this.setupHttpLegacy(settings, registry, definitions)
    } else {
      this.setupWsRuntime(settings, registry)
    }
  }

  /**
   * Set up the old HTTP-legacy path: AgentSession + OpenAiCompatibleAdapter.
   */
  private setupHttpLegacy(
    settings: import("@live2d-agent/shared").AppSettings,
    registry: ToolRegistry,
    definitions: import("@live2d-agent/agent-core").ToolDefinition[],
  ): void {
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

    this.wsSessionManager = new WsSessionManager(() => new OpenAiCompatibleWsClient({
      baseUrl: settings.openaiBaseUrl.replace(/\/$/, ""),
      apiKey: settings.openaiApiKey ?? "",
      model: settings.openaiModel,
      onRawSend: (request) => { this.lastModelRequest = request },
      onRawReceive: (response) => { this.lastModelResponse = response },
    }))
    this.runController = new RunController(
      this.conversationManager!,
      this.wsSessionManager!,
      {
        toolRegistry: registry,
        runtime: {
          executeMany: async (calls) => {
            const actions: AgentAction[] = calls.map((call) => ({
              id: call.id,
              providerToolCallId: call.id,
              tool: call.tool,
              args: call.args,
              source: "llm",
              createdAt: Date.now(),
            }))
            const results = await this.executeMany(actions)
            return results.map((result) => ({
              id: result.providerToolCallId ?? result.actionId,
              ok: result.ok,
              content: result.content,
              data: result.data,
            }))
          },
        },
        permission: {
          check: async (actions) => {
            const agentActions: AgentAction[] = actions.map((action) => ({
              id: action.id,
              providerToolCallId: action.id,
              tool: action.tool,
              args: action.args,
              source: "llm",
              createdAt: Date.now(),
            }))
            const decision = await this.deps.permissions.check(agentActions)
            return {
              status: decision.status,
              reason: decision.reason,
              actions: decision.actions.map((action) => ({ id: action.id, tool: action.tool, args: action.args })),
            }
          },
        },
        artifactWriter: this.createToolArtifactWriter(),
      },
      new ContextManager(),
    )
    this.runController.setSystemInstructions(this.composeActiveSystemPrompt())
    this.runController.onEvent((event) => this.captureRuntimeEvent(event))
    this.wsSessionManager.onEvent((event) => this.captureRuntimeEvent(event))

    const toolDefs = definitions.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      permission: d.permission,
    }))
    const legacyRegistry = new ToolRegistry()
    legacyRegistry.register(...toolDefs)
    this.session = new AgentSession(model, legacyRegistry, this, this.deps.permissions, this.deps.trace, this.events, {
      maxSteps: settings.agent.maxSteps,
      emotion: settings.emotion,
    })
  }

  /**
   * Set up the default WS runtime path: AssistantRuntime + MimoWsRuntime.
   */
  private setupWsRuntime(
    settings: import("@live2d-agent/shared").AppSettings,
    registry: ToolRegistry,
  ): void {
    const systemPrompt = this.composeActiveSystemPrompt()

    // Create ProviderRuntime via registry
    // Note: MimoWsRuntimeConfig does not support onRawSend/onRawReceive hooks,
    // so lastModelRequest/lastModelResponse will not be populated for the WS path.
    // This is acceptable per plan §4 — hooks are best-effort diagnostics.
    const providerRegistry = new DefaultProviderRuntimeRegistry()
    providerRegistry.register("mimo", {
      create: (input) => new MimoWsRuntime({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
      }),
    })
    providerRegistry.register("openai-compatible", {
      create: (input) => new MimoWsRuntime({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
      }),
    })

    const provider = providerRegistry.create(
      settings.openaiBaseUrl.includes("mimo") ? "mimo" : "openai-compatible",
      {
        providerId: settings.openaiBaseUrl.includes("mimo") ? "mimo" : "openai-compatible",
        model: settings.openaiModel,
        apiKey: settings.openaiApiKey ?? "",
        baseUrl: settings.openaiBaseUrl.replace(/\/$/, ""),
      },
    )

    // Create adapters
    const store = new ConversationStoreAdapter(this.conversationManager!)
    const contextBuilder = new ContextBuilderAdapter(systemPrompt, settings.openaiModel)
    const toolManager = new ToolManagerAdapter(registry, this)

    // Create AssistantRuntime
    this.assistantRuntime = new AssistantRuntime({
      provider,
      conversationStore: store,
      contextBuilder,
      toolManager,
      model: settings.openaiModel,
      systemPrompt,
    })

    // Wire bridge
    this.assistantRuntimeUnsub = this.assistantRuntime.onEvent((event) => this.bridge.process(event))
    this.bridgeUnsub = this.bridge.subscribe((event) => {
      this.deps.trace.append(event)
      this.events.emit(event)
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

  async sendUserMessage(input: string | { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: Array<{ id: string; kind: string; mimeType: string }>; conversationId?: string }): Promise<void> {
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

    const text = typeof input === "string" ? input : input.text
    const attachments = typeof input === "object" ? input.attachments : undefined
    const conversationId = (typeof input === "object" && input.conversationId) || this.activeConversationId!

    // Emit user message added event (consistent for both paths)
    this.emit({
      type: "message.added",
      message: {
        id: `msg_user_${Date.now()}`,
        role: "user",
        content: text,
        createdAt: Date.now(),
        attachments,
      },
    })

    if (this.runtimeMode === "http-legacy") {
      if (!this.session) this.reconfigure()
      await this.session?.runUserMessage(input)
      return
    }

    // Default WS runtime path
    if (!this.assistantRuntime) this.reconfigure()
    await this.assistantRuntime?.sendUserMessage(conversationId, text)
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

  private createToolArtifactWriter(): ArtifactWriter {
    return {
      writeArtifact: async (name, content, mimeType = "text/plain") => {
        const ref = this.deps.artifacts.saveArtifact({
          kind: "tool-output",
          mimeType,
          data: Buffer.from(content, "utf8"),
          ext: ".txt",
        })
        return { id: ref.id, path: ref.path, size: ref.size }
      },
    }
  }

  private captureRuntimeEvent(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case "run.started":
        this.emit({ type: "agent.thinking" })
        break
      case "run.completed":
        this.emit({ type: "agent.idle" })
        break
      case "run.cancelled":
        this.emit({ type: "agent.idle" })
        break
      case "run.failed":
        this.emit({ type: "agent.error", error: event.error.message })
        this.emit({ type: "agent.idle" })
        break
      case "assistant.message.completed": {
        const message = this.conversationManager
          ?.getMessages(event.conversationId)
          .find((item) => item.id === event.messageId)
        if (message && message.content.trim().length > 0) {
          this.emit({
            type: "message.added",
            message: {
              id: message.id,
              role: "assistant",
              content: message.content,
              createdAt: message.createdAt,
            },
          })
        }
        break
      }
      case "tool.call.waiting_approval":
        this.avatarState = "waiting_approval"
        break
      case "tool.call.created":
        this.lastToolCall = event.toolCall
        this.runtimeToolCalls.set(event.toolCall.id, { name: event.toolCall.name, args: event.toolCall.arguments })
        break
      case "tool.call.started":
        {
        const call = this.runtimeToolCalls.get(event.toolCallId)
        this.emit({
          type: "tool.started",
          action: {
            id: event.toolCallId,
            providerToolCallId: event.toolCallId,
            tool: call?.name ?? "task.finish",
            args: call?.args ?? {},
            source: "llm",
            createdAt: Date.now(),
          },
        })
        }
        break
      case "tool.call.completed":
      case "tool.call.failed":
        // Tool result details are captured via executeMany()/PermissionService;
        // keep the runtime event available in debug state without inventing an
        // incompatible AgentEvent payload.
        this.lastToolResult = event
        break
      case "ws.error":
        this.emit({ type: "agent.error", error: event.error.message })
        break
    }
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

/* ------------------------------------------------------------------ */
/*  Adapter classes for AssistantRuntime (Phase 3/4)                    */
/* ------------------------------------------------------------------ */

/**
 * Adapts ConversationManager → ConversationStore interface.
 */
class ConversationStoreAdapter implements ConversationStore {
  constructor(private readonly mgr: ConversationManager) {}

  appendUserMessage(conversationId: string, text: string): { id: string } {
    const msg = this.mgr.appendUserMessage(conversationId, text)
    if (!msg) throw new Error(`Conversation not found: ${conversationId}`)
    return msg
  }

  appendAssistantMessage(conversationId: string): { id: string } | null {
    const msg = this.mgr.appendAssistantMessage(conversationId)
    return msg ? { id: msg.id } : null
  }

  appendToolResultMessage(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    output: string,
  ): void {
    // ConversationManager doesn't have a dedicated tool message append.
    // Append as a user message with tool call metadata for now.
    const conv = (this.mgr as any).getConversation(conversationId)
    if (!conv) return
    conv.messages.push({
      id: `msg_tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      role: "tool" as const,
      content: output,
      createdAt: Date.now(),
    })
  }

  updateAssistantMessage(conversationId: string, messageId: string, content: string): boolean {
    return this.mgr.updateAssistantMessage(conversationId, messageId, content)
  }

  setRemoteResponseId(conversationId: string, responseId: string | null): void {
    this.mgr.setLastRemoteContextId(conversationId, responseId)
  }

  getRemoteResponseId(conversationId: string): string | null {
    const conv = (this.mgr as any).getConversation(conversationId)
    return conv?.lastRemoteContextId ?? null
  }

  getConversationMessages(
    conversationId: string,
  ): Array<{ id: string; role: string; content: string }> {
    return this.mgr.getMessages(conversationId)
  }

  hasConversation(conversationId: string): boolean {
    return this.mgr.getConversation(conversationId) !== undefined
  }
}

/**
 * Simple ContextBuilder that wraps system prompt + messages into canonical model input.
 *
 * Phase 4: Text-only messages. Attachments are preserved in the parameter structure
 * but not encoded (audio returns unsupported error per plan §8.3).
 */
class ContextBuilderAdapter implements ContextBuilder {
  constructor(
    private readonly systemPrompt: string,
    private readonly model: string,
  ) {}

  buildCreateInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    userText: string
    messages: Array<{ id: string; role: string; content: string }>
    tools: CanonicalToolDefinition[]
    remoteResponseId?: string | null
  }): CanonicalCreateInput {
    const messages: ModelMessage[] = []

    // System message
    messages.push({
      role: "system",
      content: [{ type: "text", text: params.systemPrompt }],
    })

    // Conversation messages (exclude system - already handled)
    for (const msg of params.messages) {
      if (msg.role === "system") continue
      const role = msg.role as "user" | "assistant" | "tool"
      messages.push({
        role,
        content: [{ type: "text", text: msg.content }],
      })
    }

    // Current user text — avoid duplicate if the last message in the
    // conversation history is already a user message with the same text
    // (AssistantRuntime appends the user message to the store before
    // calling buildCreateInput, so params.messages already contains it).
    if (params.userText) {
      const lastMsg = params.messages[params.messages.length - 1]
      const alreadyIncluded = lastMsg?.role === "user" && lastMsg.content === params.userText
      if (!alreadyIncluded) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: params.userText }],
        })
      }
    }

    return {
      conversationId: params.conversationId,
      runId: params.runId,
      model: this.model,
      remoteResponseId: params.remoteResponseId ?? null,
      messages,
      tools: params.tools,
      toolChoice: "auto",
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
  }

  buildContinuationInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    toolResult: CanonicalToolResult
    tools: CanonicalToolDefinition[]
    previousResponseId: string | null
  }): CanonicalToolContinuationInput {
    return {
      conversationId: params.conversationId,
      runId: params.runId,
      model: this.model,
      previousResponseId: params.previousResponseId,
      toolResult: params.toolResult,
      tools: params.tools,
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
  }
}

/**
 * ToolManager backed by ToolRegistry + AgentService execution.
 */
class ToolManagerAdapter implements ToolManager {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly agent: AgentService,
  ) {}

  getEnabledTools(): CanonicalToolDefinition[] {
    return this.registry.getDefinitions().map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.inputSchema as any,
    }))
  }

  validateToolCall(call: ModelToolCall): ToolValidationResult {
    const def = this.registry.get(call.name)
    if (!def) {
      return { valid: false, error: `Unknown tool: ${call.name}` }
    }
    // Basic JSON schema validation — check required params exist
    const schema = def.inputSchema as Record<string, unknown>
    const required = (schema as any)?.required as string[] | undefined
    if (required && Array.isArray(required)) {
      const args = call.arguments || {}
      for (const key of required) {
        if (args[key] === undefined || args[key] === null) {
          return { valid: false, error: `Missing required parameter: ${key}` }
        }
      }
    }
    return { valid: true }
  }

  async executeToolCall(call: ValidatedToolCall): Promise<CanonicalToolResult> {
    const action: AgentAction = {
      id: call.callId,
      providerToolCallId: call.callId,
      tool: call.name,
      args: call.arguments,
      source: "llm",
      createdAt: Date.now(),
    }

    const results = await this.agent.executeMany([action])
    const result = results[0]

    if (result) {
      return {
        callId: call.callId,
        name: call.name,
        status: result.ok ? "ok" : "error",
        output: result.content,
        summary: result.ok ? `Executed ${call.name}` : result.content,
      }
    }

    return {
      callId: call.callId,
      name: call.name,
      status: "error",
      output: "Tool execution returned no result",
      summary: "Tool execution returned no result",
    }
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
