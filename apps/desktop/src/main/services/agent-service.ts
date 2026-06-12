import { clipboard, desktopCapturer } from "electron"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { AgentSession, AssistantRuntime, ContextManager, ConversationManager, DefaultProviderRuntimeRegistry, EventBus, RunController, ToolRegistry, WsSessionManager, composePromptPresetInstructions, composeSystemPrompt, isEmotionPromptInjected, ToolResultLimiter, WS_RUNTIME_CONSTANTS, estimateTokens, sanitizeTextForTts, segmentLongText, extractTtsInstruction, isTtsInstructionInjected, buildToolHistorySummary, type AgentEvent, type AgentAction, type AgentRuntimeEvent, type ArtifactWriter, type ToolResult, type ToolRuntime, type ToolArtifact, type ConversationStore, type ConversationStoreMessage, type ContextBuilder, type ToolManager, type ToolValidationResult, type CanonicalToolDefinition, type ModelToolCall, type ValidatedToolCall, type CanonicalToolResult, type CanonicalCreateInput, type CanonicalToolContinuationInput, type AssistantRuntimeEvent, type ProviderRuntime, type ModelMessage, type ModelContentPart, type AgentMessageMetadata, type AgentMessage, type ModelAdapter } from "@live2d-agent/agent-core"
import { OpenAiCompatibleAdapter, OpenAiCompatibleWsClient, MimoWsRuntime } from "@live2d-agent/model-openai-compatible"
import { createDefaultTools, type RuntimeToolContext } from "@live2d-agent/tools"
import type { ArtifactRef, AudioArtifactRef, AudioContextAttachment, DebugEmotionInfo, Emotion, MessageAudioState } from "@live2d-agent/shared"
import { DEFAULT_TTS_EMOTION_INSTRUCTIONS, composeTtsNaturalEmotionInstruction } from "@live2d-agent/shared"
import type { EmotionSource } from "@live2d-agent/agent-core"
import type { ArtifactRef as ArtifactRefType } from "@live2d-agent/shared"
import type { ArtifactStore } from "./artifact-store.js"
import type { PermissionService } from "./permission-service.js"
import type { PromptService } from "./prompt-service.js"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"
import type { TtsService } from "./tts/tts-service.js"
import type { McpService } from "./mcp-service.js"
import { MEMORY_GUIDANCE, MemoryStore, type MemoryTarget } from "./memory-store.js"
import { AgentRuntimeEventBridge } from "../agent-runtime-event-bridge.js"
import { resolveRuntimeMode } from "../runtime-mode.js"

export interface AgentServiceDeps {
  settings: SettingsService
  trace: TraceService
  permissions: PermissionService
  artifacts: ArtifactStore
  prompts: PromptService
  tts: TtsService
  mcp?: McpService
}

interface EmotionDebugState {
  lastEmotion: Emotion
  lastSource: EmotionSource
  lastRawTag?: string
  lastParseWarning?: string
}

function buildCompanionWatchSystemInstruction(): string {
  return [
    "【系统指令｜陪看模式主动观察】",
    "这条消息不是用户手动输入，而是桌面助手的陪看模式定时触发。随消息附带的是用户当前屏幕截图。",
    "请结合当前对话上下文和这张屏幕内容，判断用户可能正在做什么；你可以自由发挥，主动找一个自然、轻松、不打扰的话题聊天，也可以给出简短提醒、吐槽、鼓励或观察。",
    "不要声称看到了截图之外无法确认的内容；如果屏幕内容不清楚，就用轻量的陪伴式回应。",
  ].join("\n")
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

  /**
   * TTS debug state for the debug panel.
   */
  private ttsDebug = {
    lastAutoGenerateAttempt: false,
    lastAutoGenerateSuccess: false,
    lastAutoGenerateError: undefined as string | undefined,
    lastGeneratedMessageId: undefined as string | undefined,
    lastInstructionInjected: false,
    /** Details of the last TTS request sent to the service. */
    lastRequestDetails: undefined as {
      messageId: string
      endpoint: string
      textPreview: string
      voiceId: string
      mode: string
      instruction?: string
      speed: number
      seed: number
    } | undefined,
    /** Details of the last TTS response (success or error). */
    lastResponseDetails: undefined as {
      ok: boolean
      audioPath?: string
      error?: string
      durationMs?: number
    } | undefined,
    /** Result of the last message lookup in regenerateTts. */
    lastRegenerateLookup: undefined as {
      messageId: string
      found: boolean
      conversationId?: string
      totalMessages?: number
      error?: string
    } | undefined,
  }

  private scheduledTtsMessageIds = new Set<string>()
  /**
   * Assistant messages observed on the renderer-facing event bus, keyed by
   * message id. The legacy HTTP AgentSession keeps its own in-memory history,
   * while the WS path stores messages in ConversationManager. Manual TTS
   * regeneration must work for both paths, so keep a small canonical lookup
   * cache from the same message.added events that render the chat bubbles.
   */
  private ttsMessageCache = new Map<string, { rawContent: string; metadata?: AgentMessageMetadata }>()

  /**
   * Stores the most recent user message payload for retry support.
   * When an LLM error occurs, the renderer can call retryLastUserMessage()
   * to re-send this payload through the normal sendUserMessage path.
   */
  private lastUserMessage?: { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: ArtifactRefType[]; conversationId?: string }
  private companionWatchTimer?: ReturnType<typeof setTimeout>
  private companionWatchRunning = false
  private companionAgentBusy = false
  private companionTtsBusy = false
  private companionVoiceBusy = false
  private memoryStore?: MemoryStore

  constructor(private readonly deps: AgentServiceDeps) {
    this.events.subscribe((event) => this.captureEvent(event))
    this.reconfigure()
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.subscribe(listener)
  }

  reconfigure(): void {
    this.stopCompanionWatchTimer()
    // Dispose old runtimes
    this.runController?.dispose()
    this.wsSessionManager?.dispose()
    this.assistantRuntimeUnsub?.()
    this.bridgeUnsub?.()
    this.bridge.clear()
    this.assistantRuntime = undefined
    this.session = undefined

    const settings = this.deps.settings.get()
    const requestedMode = settings.agent.runtimeMode ?? "ws"
    const resolution = resolveRuntimeMode(requestedMode, settings.openaiBaseUrl)
    if (resolution.fallbackReason) {
      console.warn(`[agent-service] ${resolution.fallbackReason}`)
    }
    this.runtimeMode = resolution.mode

    this.configureMemoryStore(settings)

    const baseTools = createDefaultTools().filter((tool) => tool.name !== "memory" || this.memoryStore)
    const definitions = this.deps.prompts.applyToolOverrides([
      ...baseTools,
      ...(this.deps.mcp?.getToolDefinitions() ?? []),
    ])
    const registry = new ToolRegistry()
    registry.register(...definitions)
    this.deps.permissions.setToolDefinitions(definitions)

    this.executors = this.createExecutors()
    // Preserve conversation history across reconfigures (e.g. settings changes).
    // Only create a new conversation manager on first boot.
    if (!this.conversationManager) {
      this.conversationManager = new ConversationManager()
      this.activeConversationId = this.conversationManager.createConversation("Default").id
    }

    if (this.runtimeMode === "http-legacy") {
      this.setupHttpLegacy(settings, registry, definitions)
    } else {
      this.setupWsRuntime(settings, registry)
    }
    this.configureCompanionWatchTimer()
  }

  /**
   * Set up the old HTTP-legacy path: AgentSession + OpenAiCompatibleAdapter.
   */
  private setupHttpLegacy(
    settings: import("@live2d-agent/shared").AppSettings,
    registry: ToolRegistry,
    definitions: import("@live2d-agent/agent-core").ToolDefinition[],
  ): void {
    const createAdapter = (modelName: string) => new OpenAiCompatibleAdapter({
      baseUrl: settings.openaiBaseUrl.replace(/\/$/, ""),
      apiKey: settings.openaiApiKey ?? "",
      model: modelName,
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
    const primaryModel = createAdapter(settings.openaiModel)
    const multimodalModelName = settings.openaiMultimodalModel?.trim()
    const model = multimodalModelName
      ? new RoutingModelAdapter(primaryModel, createAdapter(multimodalModelName))
      : primaryModel

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
    const contextBuilder = new ContextBuilderAdapter(systemPrompt, settings.openaiModel, this.deps.artifacts, settings.openaiMultimodalModel)
    const toolManager = new ToolManagerAdapter(registry, this, this.deps.permissions)

    // Create AssistantRuntime
    this.assistantRuntime = new AssistantRuntime({
      provider,
      conversationStore: store,
      contextBuilder,
      toolManager,
      model: settings.openaiModel,
      systemPrompt,
      artifactWriter: this.createToolArtifactWriter(),
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
   *  role prompt + user information prompt in a hard-coded markdown structure
   *  + emotion tag instructions (when settings allow it)
   *  + TTS instruction prompt (when LLM-controlled emotion mode is active)
   *
   * Prompt presets live in SettingsService so the renderer can edit them.
   * We do NOT persist the composed prompt with emotion instructions — that
   * keeps settings clean and lets emotion injection stay independently gated.
   */
  private composeActiveSystemPrompt(): string {
    const settings = this.deps.settings.get()
    const baseParts = [composePromptPresetInstructions(settings.promptPresets)]
    if (this.memoryStore) baseParts.push(["【系统指令｜持久化记忆】", MEMORY_GUIDANCE].join("\n"))
    const memoryBlocks: string[] = []
    if (this.memoryStore && settings.memory.enabled) {
      const block = this.memoryStore.formatForSystemPrompt("memory")
      if (block) memoryBlocks.push(block)
    }
    if (this.memoryStore && settings.memory.userProfileEnabled) {
      const block = this.memoryStore.formatForSystemPrompt("user")
      if (block) memoryBlocks.push(block)
    }
    const base = [...baseParts, ...memoryBlocks].filter(Boolean).join("\n\n")
    const prompt = composeSystemPrompt(base, settings.emotion, settings.tts)
    const mcpTools = this.deps.mcp?.getToolDefinitions() ?? []
    if (!settings.mcp.enabled || mcpTools.length === 0) return prompt
    const searchTools = mcpTools.filter((tool) => /search|fetch|browse|web/i.test(`${tool.name} ${tool.description}`))
    const toolSummary = (searchTools.length > 0 ? searchTools : mcpTools)
      .slice(0, 12)
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join("\n")
    return [
      prompt,
      "",
      "【系统指令｜MCP 工具能力】",
      "当前已接入 MCP 工具。需要实时信息、网页搜索、联网查询或抓取网页内容时，优先调用可用的 MCP 搜索/网页工具；不要声称自己没有联网搜索能力。若工具调用失败，应如实说明失败原因。",
      "当前可用 MCP 工具摘要：",
      toolSummary,
    ].join("\n")
  }

  async sendUserMessage(input: string | { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: ArtifactRefType[]; conversationId?: string; skipCompanionScreenshot?: boolean; rememberForRetry?: boolean; suppressUserMessageEvent?: boolean }): Promise<void> {
    this.noteCompanionActivity("user")
    const text = typeof input === "string" ? input : input.text
    const attachments = typeof input === "object" ? input.attachments : undefined
    const artifactRefs = typeof input === "object" ? input.artifactRefs : undefined
    const conversationId = (typeof input === "object" && input.conversationId) || this.activeConversationId!
    const skipCompanionScreenshot = typeof input === "object" && input.skipCompanionScreenshot === true
    const rememberForRetry = typeof input !== "object" || input.rememberForRetry !== false
    const suppressUserMessageEvent = typeof input === "object" && input.suppressUserMessageEvent === true

    if (rememberForRetry) this.lastUserMessage = { text, attachments, artifactRefs, conversationId }

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

    const mergedArtifactRefs = skipCompanionScreenshot
      ? artifactRefs
      : await this.withCompanionUserScreenshot(artifactRefs)

    if (rememberForRetry) this.lastUserMessage = { text, attachments, artifactRefs: mergedArtifactRefs, conversationId }

    if (this.runtimeMode === "http-legacy") {
      if (!this.session) this.reconfigure()
      await this.session?.runUserMessage({ text, attachments, artifactRefs: mergedArtifactRefs })
      return
    }

    // The WS runtime does not emit renderer-facing user messages itself.
    // The legacy AgentSession path does, so keep this emit WS-only to avoid
    // rendering the same user input twice with different generated IDs.
    const userMessageExtra: Record<string, unknown> = {}
    if (mergedArtifactRefs && mergedArtifactRefs.length > 0) {
      userMessageExtra.artifactRefs = mergedArtifactRefs
    }
    if (!suppressUserMessageEvent) {
      this.emit({
        type: "message.added",
        message: {
          id: `msg_user_${Date.now()}`,
          role: "user",
          content: text,
          createdAt: Date.now(),
          attachments,
          ...(Object.keys(userMessageExtra).length > 0 ? { extra: userMessageExtra } : {}),
        },
      })
    }

    // Default WS runtime path
    if (!this.assistantRuntime) this.reconfigure()

    // Pass full text, attachments, and artifactRefs to AssistantRuntime
    await this.assistantRuntime?.sendUserMessage(conversationId, {
      text,
      attachments: attachments as any,
      artifactRefs: mergedArtifactRefs as any,
    })
  }

  private async withCompanionUserScreenshot(artifactRefs: ArtifactRefType[] | undefined): Promise<ArtifactRefType[] | undefined> {
    if (!this.deps.settings.get().companionWatch.attachScreenshotOnUserMessage) return artifactRefs
    try {
      const ref = await this.captureScreenshotArtifact()
      return [...(artifactRefs ?? []), ref]
    } catch (error) {
      this.emit({
        type: "message.added",
        message: {
          id: `msg_sys_${Date.now()}`,
          role: "assistant",
          content: `陪看模式截屏失败：${error instanceof Error ? error.message : String(error)}`,
          createdAt: Date.now(),
          extra: { error: { code: "COMPANION_SCREENSHOT_FAILED", message: String(error), recoverable: true } },
        },
      })
      return artifactRefs
    }
  }

  private async captureScreenshotArtifact(): Promise<ArtifactRefType> {
    const shot = await this.createRuntimeContext().captureScreenshot()
    return this.deps.artifacts.saveArtifact({
      kind: "screenshot",
      mimeType: shot.mimeType,
      data: shot.data,
      ext: ".png",
    }) as ArtifactRefType
  }

  private configureCompanionWatchTimer(): void {
    this.scheduleNextCompanionWatchTick()
  }

  private stopCompanionWatchTimer(): void {
    if (this.companionWatchTimer) clearTimeout(this.companionWatchTimer)
    this.companionWatchTimer = undefined
  }

  private scheduleNextCompanionWatchTick(): void {
    this.stopCompanionWatchTimer()
    const watch = this.deps.settings.get().companionWatch
    if (!watch.proactiveEnabled) return
    if (!this.isCompanionIdle()) return
    const delayMs = this.companionWatchIntervalMs(watch.proactiveInterval)
    this.companionWatchTimer = setTimeout(() => {
      void this.runCompanionWatchTick()
    }, delayMs)
  }

  private isCompanionIdle(): boolean {
    return !this.companionAgentBusy && !this.companionTtsBusy && !this.companionVoiceBusy
  }

  noteCompanionActivity(source: "user" | "tts" | "voice" = "user", active?: boolean): void {
    this.stopCompanionWatchTimer()
    if (source === "tts" && active !== undefined) this.companionTtsBusy = active
    if (source === "voice" && active !== undefined) this.companionVoiceBusy = active
    this.scheduleNextCompanionWatchTick()
  }

  private companionWatchIntervalMs(interval: import("@live2d-agent/shared").CompanionWatchSettings["proactiveInterval"]): number {
    if (interval === "1m") return 60_000
    if (interval === "2m") return 120_000
    if (interval === "random") return 30_000 + Math.floor(Math.random() * 90_001)
    return 30_000
  }

  private async runCompanionWatchTick(): Promise<void> {
    if (this.companionWatchRunning) return
    if (!this.isCompanionIdle()) return
    this.companionWatchRunning = true
    try {
      if (!this.deps.settings.get().companionWatch.proactiveEnabled) return
      const ref = await this.captureScreenshotArtifact()
      const input = { text: buildCompanionWatchSystemInstruction(), artifactRefs: [ref] }
      if (this.runtimeMode === "http-legacy") {
        if (!this.session) this.reconfigure()
        await this.session?.runTransientUserMessage(input)
      } else {
        if (!this.assistantRuntime) this.reconfigure()
        await this.assistantRuntime?.sendTransientUserMessage(this.activeConversationId!, input)
      }
    } catch (error) {
      this.emit({
        type: "message.added",
        message: {
          id: `msg_sys_${Date.now()}`,
          role: "assistant",
          content: `陪看主动观察失败：${error instanceof Error ? error.message : String(error)}`,
          createdAt: Date.now(),
          extra: { error: { code: "COMPANION_PROACTIVE_FAILED", message: String(error), recoverable: true } },
        },
      })
    } finally {
      this.companionWatchRunning = false
      this.scheduleNextCompanionWatchTick()
    }
  }

  /**
   * Retry the most recent user message. Replays the stored payload
   * (text, attachments, artifactRefs) through the normal sendUserMessage
   * path. If no previous message exists, emits a visible error.
   */
  async retryLastUserMessage(): Promise<void> {
    if (!this.lastUserMessage) {
      this.emit({
        type: "message.added",
        message: {
          id: `msg_sys_${Date.now()}`,
          role: "assistant",
          content: "没有可重发的消息。",
          createdAt: Date.now(),
          extra: { error: { code: "NO_MESSAGE_TO_RETRY", message: "No previous user message to retry", recoverable: false } },
        },
      })
      return
    }
    const { text, attachments, artifactRefs, conversationId } = this.lastUserMessage
    const removedPreviousTurn = this.pruneLastFailedRetryTurn(text, conversationId)
    await this.sendUserMessage({
      text,
      attachments,
      artifactRefs,
      conversationId,
      rememberForRetry: false,
      skipCompanionScreenshot: true,
      suppressUserMessageEvent: removedPreviousTurn,
    })
  }

  private pruneLastFailedRetryTurn(text: string, conversationId: string | undefined): boolean {
    if (this.runtimeMode === "http-legacy") {
      const messages = this.session?.messages
      if (!messages) return false
      let startIndex = -1
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role === "user" && message.content === text) {
          startIndex = index
          break
        }
      }
      if (startIndex < 0) return false
      messages.splice(startIndex)
      return true
    }

    if (!conversationId) return false
    return this.conversationManager?.removeLastTurnByUserContent(conversationId, text) ?? false
  }

  clearActiveContext(): void {
    this.deps.permissions.resetSessionState()
    this.reconfigure()
    this.avatarState = "idle"
    this.emit({
      type: "emotion.set",
      emotion: this.deps.settings.get().emotion.defaultEmotion,
      source: "fallback",
      messageId: `context_clear_${Date.now()}`,
    })
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
    tts?: {
      enabled: boolean
      apiBaseUrl: string
      selectedVoiceId?: string
      ttsMode: string
      connectionStatus: string
      instructionInjected: boolean
      lastAutoGenerateAttempt: boolean
      lastAutoGenerateSuccess: boolean
      lastAutoGenerateError?: string
      lastRequestDetails?: {
        messageId: string
        endpoint: string
        textPreview: string
        voiceId: string
        mode: string
        instruction?: string
        speed: number
        seed: number
      }
      lastResponseDetails?: {
        ok: boolean
        audioPath?: string
        error?: string
        durationMs?: number
      }
      lastRegenerateLookup?: {
        messageId: string
        found: boolean
        conversationId?: string
        totalMessages?: number
        error?: string
      }
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
      rawSystemPrompt: composePromptPresetInstructions(settings.promptPresets),
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
      tts: {
        enabled: settings.tts.enabled,
        apiBaseUrl: settings.tts.apiBaseUrl,
        selectedVoiceId: settings.tts.selectedVoiceId,
        ttsMode: settings.tts.ttsMode,
        connectionStatus: "unknown",
        instructionInjected: isTtsInstructionInjected(composedPrompt),
        lastAutoGenerateAttempt: this.ttsDebug.lastAutoGenerateAttempt,
        lastAutoGenerateSuccess: this.ttsDebug.lastAutoGenerateSuccess,
        lastAutoGenerateError: this.ttsDebug.lastAutoGenerateError,
        lastRequestDetails: this.ttsDebug.lastRequestDetails,
        lastResponseDetails: this.ttsDebug.lastResponseDetails,
        lastRegenerateLookup: this.ttsDebug.lastRegenerateLookup,
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

  /**
   * Schedule TTS auto-generation for an assistant message.
   * This is non-blocking — it fires and forgets the async TTS generation.
   */
  private scheduleTtsAutoGenerationForMessage(message: AgentMessage): void {
    const settings = this.deps.settings.get()

    if (!settings.tts.enabled) return
    if (!settings.tts.autoGenerateOnAssistantMessage) return
    if (this.scheduledTtsMessageIds.has(message.id)) return

    const rawContent = normalizeMessageContentToText(message.content)
    if (!rawContent.trim()) return

    // 清理后的文本会在生成请求中按 20-40 字智能分段，不再因长文本跳过自动生成。
    const cleanedText = sanitizeTextForTts(rawContent)
    if (!cleanedText) return

    this.scheduledTtsMessageIds.add(message.id)

    this.generateTtsForMessage({
      messageId: message.id,
      rawContent,
      metadata: message.metadata,
    }).catch((err) => {
      console.error("[agent-service] TTS auto-generation failed:", err)
      this.ttsDebug.lastAutoGenerateError = err instanceof Error ? err.message : String(err)
    })
  }

  /**
   * Build a TTS generation request for a given assistant message.
   * Unified logic used by both auto-generation and manual regeneration.
   */
  private buildTtsRequestForMessage(
    messageId: string,
    rawContent: string,
    metadata?: AgentMessageMetadata,
  ): { messageId: string; text: string; textSegments?: string[]; voiceId: string; mode: "standard" | "emotion_enhanced"; emotionControlMode: "default_mapping" | "llm_controlled"; instruction?: string; speed: number; seed: number } | null {
    const settings = this.deps.settings.get()

    if (!settings.tts.enabled) {
      this.emit({ type: "tts.error", messageId, error: "TTS 未启用" })
      return null
    }

    if (!settings.tts.selectedVoiceId) {
      this.emit({ type: "tts.error", messageId, error: "请先在设置页选择一个 TTS 音色" })
      return null
    }

    const cleanedText = sanitizeTextForTts(rawContent)
    if (!cleanedText) {
      this.emit({ type: "tts.error", messageId, error: "清理后的文本为空，无法生成语音" })
      return null
    }

    let instruction: string | undefined

    if (settings.tts.ttsMode === "emotion_enhanced") {
      if (settings.tts.emotionControlMode === "default_mapping") {
        const emotionResult = this.parseEmotionFromMessage(rawContent, metadata)
        instruction = composeTtsNaturalEmotionInstruction(
          DEFAULT_TTS_EMOTION_INSTRUCTIONS[emotionResult.emotion] ?? DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral,
        )
      } else {
        // llm_controlled mode — extract instruction from the message
        const ttsResult = extractTtsInstruction(rawContent)
        if (ttsResult) {
          instruction = composeTtsNaturalEmotionInstruction(ttsResult.instruction)
          this.ttsDebug.lastInstructionInjected = true
        } else {
          // Fallback to default mapping if no instruction found
          const emotionResult = this.parseEmotionFromMessage(rawContent, metadata)
          instruction = composeTtsNaturalEmotionInstruction(
            DEFAULT_TTS_EMOTION_INSTRUCTIONS[emotionResult.emotion] ?? DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral,
          )
        }
      }
    }

    const textSegments = segmentLongText(cleanedText, 40, 30)

    return {
      messageId,
      text: cleanedText,
      textSegments: textSegments.length > 1 ? textSegments : undefined,
      voiceId: settings.tts.selectedVoiceId,
      mode: settings.tts.ttsMode,
      emotionControlMode: settings.tts.emotionControlMode,
      instruction,
      speed: settings.tts.speed,
      seed: settings.tts.seed,
    }
  }

  /**
   * Generate TTS audio for an assistant message.
   * Unified entry point for both auto-generation and manual regeneration.
   */
  async generateTtsForMessage(input: { messageId: string; rawContent: string; metadata?: AgentMessageMetadata }): Promise<void> {
    const { messageId, rawContent, metadata } = input
    const settings = this.deps.settings.get()
    this.ttsDebug.lastAutoGenerateAttempt = true
    this.ttsDebug.lastGeneratedMessageId = messageId

    const req = this.buildTtsRequestForMessage(messageId, rawContent, metadata)
    if (!req) {
      this.ttsDebug.lastAutoGenerateSuccess = false
      return
    }

    // Record request details for debugging
    const endpoint = req.mode === "emotion_enhanced" && req.instruction ? "/v1/tts/instruct" : "/v1/tts/zero-shot"
    this.ttsDebug.lastRequestDetails = {
      messageId: req.messageId,
      endpoint,
      textPreview: req.text.slice(0, 120),
      voiceId: req.voiceId,
      mode: req.mode,
      instruction: req.instruction,
      speed: req.speed,
      seed: req.seed,
    }

    const startedAt = Date.now()
    try {
      this.emit({ type: "tts.generating", messageId })

      const isSegmented = (req.textSegments?.length ?? 0) > 1
      const result = await this.deps.tts.generate(req, isSegmented ? {
        onSegmentReady: ({ audioPath }) => {
          const audioUrl = pathToFileURL(audioPath).href
          this.emit({ type: "tts.ready", messageId, audioPath, audioUrl })
        },
      } : undefined)

      this.ttsDebug.lastResponseDetails = {
        ok: result.ok,
        audioPath: result.audioPath,
        error: result.error,
        durationMs: Date.now() - startedAt,
      }

      if (result.ok && result.audioPath) {
        this.ttsDebug.lastAutoGenerateSuccess = true
        this.ttsDebug.lastAutoGenerateError = undefined
        if (!isSegmented) {
          const audioUrl = pathToFileURL(result.audioPath).href
          this.emit({ type: "tts.ready", messageId, audioPath: result.audioPath, audioUrl })
        }
      } else {
        this.ttsDebug.lastAutoGenerateSuccess = false
        this.ttsDebug.lastAutoGenerateError = result.error ?? "TTS generation failed"
        this.emit({ type: "tts.error", messageId, error: result.error ?? "TTS generation failed" })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.ttsDebug.lastResponseDetails = {
        ok: false,
        error: msg,
        durationMs: Date.now() - startedAt,
      }
      this.ttsDebug.lastAutoGenerateError = msg
      this.ttsDebug.lastAutoGenerateSuccess = false
      this.emit({ type: "tts.error", messageId, error: msg })
    }
  }

  /**
   * Parse emotion from raw message content.
   * Returns the emotion value if found, or the default emotion.
   */
  private parseEmotionFromMessage(rawContent: string, metadata?: AgentMessageMetadata): { emotion: string; source: "llm-tag" | "fallback" } {
    const settings = this.deps.settings.get()
    // Priority 1: metadata.emotion (set by HTTP legacy / WS bridge)
    if (metadata?.emotion) {
      return { emotion: metadata.emotion, source: "llm-tag" }
    }
    // Priority 2: raw content emotion tag
    const emotionTagMatch = rawContent.match(/<emotion\s+value\s*=\s*["']([a-z_]+)["']\s*\/>/i)
    if (emotionTagMatch && emotionTagMatch[1]) {
      return { emotion: emotionTagMatch[1], source: "llm-tag" }
    }
    return { emotion: settings.emotion.defaultEmotion, source: "fallback" }
  }

  /**
   * Regenerate TTS audio for a specific message (manual trigger).
   * Delegates to the unified generateTtsForMessage.
   */
  async regenerateTts(messageId: string): Promise<void> {
    const settings = this.deps.settings.get()
    if (!settings.tts.enabled) {
      this.ttsDebug.lastRegenerateLookup = {
        messageId,
        found: false,
        error: "TTS 未启用",
      }
      this.emit({ type: "tts.error", messageId, error: "TTS 未启用" })
      return
    }
    // Look up the original assistant message to get its content and metadata.
    // Prefer the event-bus cache because legacy HTTP AgentSession messages are
    // not stored in ConversationManager, but they are the messages whose ids the
    // renderer passes back when the user clicks “重新生成”.
    const cached = this.ttsMessageCache.get(messageId)
    const convId = this.activeConversationId ?? ""
    const allMessages = this.conversationManager?.getMessages(convId) ?? []
    const message = allMessages.find((m) => m.id === messageId)
    const rawContent = cached?.rawContent ?? (message ? normalizeMessageContentToText(message.content) : undefined)
    const metadata = cached?.metadata ?? (message as any)?.metadata

    this.ttsDebug.lastRegenerateLookup = {
      messageId,
      found: Boolean(rawContent),
      conversationId: convId,
      totalMessages: allMessages.length,
      error: rawContent ? undefined : `Message ${messageId} not found in TTS cache or conversation ${convId} (${allMessages.length} messages)`,
    }

    if (!rawContent) {
      this.emit({ type: "tts.error", messageId, error: "找不到原始消息" })
      return
    }
    await this.generateTtsForMessage({
      messageId,
      rawContent,
      metadata,
    })
  }

  emitEvent(event: AgentEvent): void {
    this.deps.trace.append(event)
    this.events.emit(event)
  }

  private async execute(action: AgentAction): Promise<ToolResult> {
    const startedAt = Date.now()
    const executor = this.executors.get(action.tool)
    if (!executor && this.deps.mcp?.hasTool(action.tool)) {
      return this.deps.mcp.execute(action)
    }
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
      ["memory", async (action) => {
        const startedAt = Date.now()
        const args = asRecord(action.args)
        const result = this.executeMemoryTool(args)
        return this.result(
          action,
          startedAt,
          result.success,
          JSON.stringify(result, null, 2),
          result,
          result.success ? undefined : "MEMORY_TOOL_ERROR",
        )
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
    this.updateCompanionIdleStateFromEvent(event)
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
    if (event.type === "message.added" && event.message.role === "assistant" && !event.message.extra?.error) {
      this.ttsMessageCache.set(event.message.id, {
        rawContent: normalizeMessageContentToText(event.message.content),
        metadata: event.message.metadata,
      })
      this.scheduleTtsAutoGenerationForMessage(event.message)
    }
  }

  private configureMemoryStore(settings: import("@live2d-agent/shared").AppSettings): void {
    this.memoryStore = undefined
    if (!settings.memory.enabled && !settings.memory.userProfileEnabled) return
    try {
      const store = new MemoryStore({
        memoryDir: this.deps.settings.getMemoryDir(),
        memoryCharLimit: settings.memory.memoryCharLimit,
        userCharLimit: settings.memory.userCharLimit,
      })
      store.loadFromDisk()
      this.memoryStore = store
    } catch (error) {
      console.warn("[agent-service] Failed to initialize memory store:", error)
    }
  }

  private executeMemoryTool(args: Record<string, unknown>): ReturnType<MemoryStore["add"]> {
    if (!this.memoryStore) return { success: false, error: "Memory is not available." }
    const action = typeof args.action === "string" ? args.action : ""
    const target = typeof args.target === "string" ? args.target : "memory"
    if (target !== "memory" && target !== "user") return { success: false, error: "Invalid target. Use memory or user." }
    if (action === "add") {
      if (typeof args.content !== "string") return { success: false, error: "content is required for add." }
      return this.memoryStore.add(target as MemoryTarget, args.content)
    }
    if (action === "replace") {
      if (typeof args.old_text !== "string" || typeof args.content !== "string") return { success: false, error: "old_text and content are required for replace." }
      return this.memoryStore.replace(target as MemoryTarget, args.old_text, args.content)
    }
    if (action === "remove") {
      if (typeof args.old_text !== "string") return { success: false, error: "old_text is required for remove." }
      return this.memoryStore.remove(target as MemoryTarget, args.old_text)
    }
    return { success: false, error: "Unknown action. Use add, replace, or remove." }
  }

  private updateCompanionIdleStateFromEvent(event: AgentEvent): void {
    const wasIdle = this.isCompanionIdle()
    if (event.type === "agent.thinking" || event.type === "tool.started" || event.type === "approval.pending") {
      this.companionAgentBusy = true
    }
    if (event.type === "agent.idle" || event.type === "agent.error") {
      this.companionAgentBusy = false
    }
    if (event.type === "tts.generating" || event.type === "tts.playing") {
      this.companionTtsBusy = true
    }
    if (event.type === "tts.ready" || event.type === "tts.error" || event.type === "tts.stopped") {
      this.companionTtsBusy = false
    }

    const isIdle = this.isCompanionIdle()
    if (!isIdle) {
      this.stopCompanionWatchTimer()
    } else if (!wasIdle || !this.companionWatchTimer) {
      this.scheduleNextCompanionWatchTick()
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

  appendUserMessage(
    conversationId: string,
    text: string,
    attachments?: Array<{ id: string; type: "audio"; label: string; artifact: { id: string; kind: string; path: string; mimeType: string; size: number; createdAt: number }; mimeType: string; durationMs: number; createdAt: number }>,
    artifactRefs?: Array<{ id: string; kind: string; path: string; mimeType: string; size: number; createdAt: number }>,
  ): { id: string } {
    const msg = this.mgr.appendUserMessage(conversationId, text)
    if (!msg) throw new Error(`Conversation not found: ${conversationId}`)

    // Store attachments and artifactRefs on the ConversationManager message
    // via the underlying Conversation object's messages array.
    const conv = (this.mgr as any).getConversation(conversationId)
    if (conv) {
      const storedMsg = conv.messages.find((m: { id: string }) => m.id === msg.id)
      if (storedMsg) {
        if (attachments && attachments.length > 0) {
          storedMsg.attachments = attachments
        }
        if (artifactRefs && artifactRefs.length > 0) {
          storedMsg.extra = { ...(storedMsg.extra || {}), artifactRefs }
        }
      }
    }

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
    historySummary?: string,
  ): void {
    const conv = (this.mgr as any).getConversation(conversationId)
    if (!conv) return
    const toolHistorySummary = historySummary ?? buildToolHistorySummary({
      toolName,
      status: "unknown",
      output,
    })
    conv.messages.push({
      id: `msg_tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      role: "tool" as const,
      content: output,
      toolCallId,
      toolName,
      extra: { toolHistorySummary },
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
  ): ConversationStoreMessage[] {
    const msgs = this.mgr.getMessages(conversationId)
    const conv = (this.mgr as any).getConversation(conversationId)
    if (!conv) return msgs
    return msgs.map((m: { id: string; role: "user" | "assistant" | "tool"; content: string; createdAt: number; toolCallId?: string; toolName?: string; extra?: Record<string, unknown> }) => {
      const stored = conv.messages.find((s: { id: string }) => s.id === m.id)
      if (stored && (stored.attachments || stored.extra)) {
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          toolCallId: m.toolCallId ?? stored.toolCallId,
          toolName: m.toolName ?? stored.toolName,
          attachments: stored.attachments,
          extra: { ...m.extra, ...stored.extra },
        }
      }
      return { id: m.id, role: m.role, content: m.content, toolCallId: m.toolCallId, toolName: m.toolName, extra: m.extra }
    })
  }

  hasConversation(conversationId: string): boolean {
    return this.mgr.getConversation(conversationId) !== undefined
  }
}

function hasImageOrAudioInput(message: Pick<AgentMessage, "attachments" | "extra"> | Pick<ConversationStoreMessage, "attachments" | "extra">): boolean {
  const attachments = message.attachments
  if (attachments?.some((attachment) => attachment.type === "audio" || attachment.type === "image")) return true

  const artifactRefs = message.extra?.artifactRefs
  return Array.isArray(artifactRefs) && artifactRefs.some((ref) => {
    const mimeType = typeof ref?.mimeType === "string" ? ref.mimeType : ""
    return mimeType.startsWith("image/") || mimeType.startsWith("audio/")
  })
}

class RoutingModelAdapter implements ModelAdapter {
  constructor(
    private readonly primary: ModelAdapter,
    private readonly multimodal: ModelAdapter,
  ) {}

  query(input: { messages: AgentMessage[]; tools: import("@live2d-agent/agent-core").ToolDefinition[] }): Promise<AgentMessage> {
    const latestUserMessage = [...input.messages].reverse().find((message) => message.role === "user")
    const adapter = latestUserMessage && hasImageOrAudioInput(latestUserMessage) ? this.multimodal : this.primary
    return adapter.query(input)
  }

  formatObservations(results: ToolResult[]): AgentMessage[] {
    return this.primary.formatObservations(results)
  }
}

/**
 * ContextBuilder that wraps system prompt + messages into canonical model input
 * with budget enforcement, message limiting, and artifact size tracking.
 *
 * Multimodal support:
 *   - Image artifactRefs from extra.artifactRefs → ModelContentPart image
 *   - Audio artifacts → ModelContentPart audio (encoder will throw
 *     UnsupportedInputPartError per plan §8.3 — no text placeholders)
 *   - AudioContextAttachment attachments → ModelContentPart audio
 *
 * Budget rules (applied to buildCreateInput):
 *   1. System prompt is always included first.
 *   2. Summary placeholder (fixed string) is added when messages are trimmed.
 *   3. Up to 16 most recent text messages are included (system-filtered).
 *   4. Token estimation uses exported `estimateTokens` (chars / 3.5 heuristic).
 *   5. Estimated tokens > 48 000 → shrink to last 8 messages.
 *   6. Estimated tokens > 64 000 → throw `context_hard_limit_exceeded`.
 *   7. Artifact raw byte budget: 12 MB per request (WS_RUNTIME_CONSTANTS.MAX_RAW_ARTIFACT_BYTES_PER_REQUEST).
 *      When inline image/audio data would exceed this budget, the last sendable
 *      image is kept and earlier raw artifacts are replaced with artifactRefs.
 */
class ContextBuilderAdapter implements ContextBuilder {
  /** Max conversation text messages to include (before token-based shrinking). */
  private static readonly MAX_TEXT_MESSAGES = 16
  /** Smaller window when soft token limit is exceeded. */
  private static readonly SHRUNK_TEXT_MESSAGES = 8

  /** Soft token limit — above this, shrink to SHRUNK_TEXT_MESSAGES. */
  private static readonly TOKEN_SOFT_LIMIT = 48_000
  /** Hard token limit — above this, refuse the request. */
  private static readonly TOKEN_HARD_LIMIT = 64_000

  /**
   * Fixed summary placeholder used when messages are trimmed.
   * Per spec: may be empty or a fixed placeholder.
   */
  private static readonly SUMMARY_PLACEHOLDER = "[Previous conversation context omitted]"

  /**
   * Maximum total bytes of inline raw artifact data (image, audio) per single request.
   */
  private static readonly MAX_ARTIFACT_RAW_BYTES =
    WS_RUNTIME_CONSTANTS.MAX_RAW_ARTIFACT_BYTES_PER_REQUEST
  private readonly runModels = new Map<string, string>()

  constructor(
    private readonly systemPrompt: string,
    private readonly model: string,
    private readonly artifactStore: ArtifactStore,
    private readonly multimodalModel?: string,
  ) {}

  buildCreateInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    userText: string
    messages: ConversationStoreMessage[]
    tools: CanonicalToolDefinition[]
    remoteResponseId?: string | null
    currentUserMessageId?: string
  }): CanonicalCreateInput {
    const modelMessages = this._buildModelMessages(params)

    const selectedModel = this.selectModelForCreate(params.messages, params.currentUserMessageId)
    this.runModels.set(params.runId, selectedModel)

    return {
      conversationId: params.conversationId,
      runId: params.runId,
      model: selectedModel,
      remoteResponseId: params.remoteResponseId ?? null,
      messages: modelMessages,
      tools: params.tools,
      toolChoice: "auto",
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
  }

  private selectModelForCreate(messages: ConversationStoreMessage[], currentUserMessageId?: string): string {
    const multimodalModel = this.multimodalModel?.trim()
    if (!multimodalModel) return this.model
    const current = currentUserMessageId
      ? messages.find((message) => message.id === currentUserMessageId)
      : messages[messages.length - 1]
    return current && hasImageOrAudioInput(current) ? multimodalModel : this.model
  }

  /**
   * Core message-building logic with budget enforcement and multimodal content.
   *
   * 1. System prompt
   * 2. Summary placeholder (if trimming occurred)
   * 3. Up to MAX_TEXT_MESSAGES messages (exclude system)
   * 4. Current user text (deduplicate against last message)
   * 5. Token estimation → shrink or throw as needed
   * 6. Artifact raw byte budget enforcement
   */
  private _buildModelMessages(
    params: {
      systemPrompt: string
      userText: string
      messages: ConversationStoreMessage[]
      currentUserMessageId?: string
    },
  ): ModelMessage[] {
    // ── Step 1: Filter and limit conversation messages ──────────────
    let convMessages = params.messages.filter((m) => m.role !== "system")
    const wasTrimmed = convMessages.length > ContextBuilderAdapter.MAX_TEXT_MESSAGES
    if (wasTrimmed) {
      convMessages = convMessages.slice(-ContextBuilderAdapter.MAX_TEXT_MESSAGES)
    }

    // ── Step 2: Build the message list ───────────────────────────────
    const modelMessages: ModelMessage[] = []

    // System prompt
    modelMessages.push({
      role: "system",
      content: [{ type: "text", text: params.systemPrompt }],
    })

    // Summary placeholder if messages were trimmed
    if (wasTrimmed) {
      modelMessages.push({
        role: "system",
        content: [{ type: "text", text: ContextBuilderAdapter.SUMMARY_PLACEHOLDER }],
      })
    }

    // Conversation messages with multimodal content parts
    // Only the message matching currentUserMessageId sends raw image/audio;
    // historical messages use file_ref instead.
    for (const msg of convMessages) {
      const isCurrentTurn = params.currentUserMessageId != null && msg.id === params.currentUserMessageId
      const messageForModel = this._messageForModel(params, msg)
      const role = msg.role as "user" | "assistant" | "tool"
      modelMessages.push({
        role,
        toolCallId: messageForModel.toolCallId,
        content: this._buildContentParts(messageForModel, isCurrentTurn),
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
        modelMessages.push({
          role: "user",
          content: [{ type: "text", text: params.userText }],
        })
      }
    }

    // ── Step 3: Token estimation and budget enforcement ──────────────
    const totalTokens = this._estimateMessagesTokens(modelMessages)

    if (totalTokens > ContextBuilderAdapter.TOKEN_HARD_LIMIT) {
      const shrunk = this._shrinkToLastN(params, 8)
      const shrunkTokens = this._estimateMessagesTokens(shrunk)
      if (shrunkTokens > ContextBuilderAdapter.TOKEN_HARD_LIMIT) {
        throw new Error(
          `context_hard_limit_exceeded: estimated ${shrunkTokens} tokens exceeds hard limit of ${ContextBuilderAdapter.TOKEN_HARD_LIMIT}`,
        )
      }
      return shrunk
    }

    if (totalTokens > ContextBuilderAdapter.TOKEN_SOFT_LIMIT) {
      return this._shrinkToLastN(params, ContextBuilderAdapter.SHRUNK_TEXT_MESSAGES)
    }

    // ── Step 4: Artifact raw byte budget ─────────────────────────────
    this._enforceArtifactByteBudget(modelMessages)

    return modelMessages
  }

  /**
   * Build content parts for a message:
   * - Text content → text part
   * - Current turn (isCurrentTurn=true):
   *     Image artifactRefs → raw image part (read from ArtifactStore)
   *     Audio artifactRefs → raw audio part (encoder may reject)
   *     Audio attachments → raw audio part
   * - Historical turn (isCurrentTurn=false):
   *     All artifactRefs → file_ref parts (no readArtifact)
   *     Audio attachments → file_ref parts (no readArtifact)
   * - No text placeholders for non-text content
   */
  private _buildContentParts(msg: ConversationStoreMessage, isCurrentTurn: boolean = false): ModelContentPart[] {
    const parts: ModelContentPart[] = []

    // Always include text content
    parts.push({ type: "text", text: msg.content })

    // Handle artifactRefs from extra (screenshots, images, etc.)
    const artifactRefs = msg.extra?.artifactRefs
    if (artifactRefs && artifactRefs.length > 0) {
      for (const ref of artifactRefs) {
        if (ref.mimeType.startsWith("image/") || ref.mimeType.startsWith("audio/")) {
          if (isCurrentTurn) {
            // Current turn: read raw data and create inline part
            try {
              const buffer = this.artifactStore.readArtifact(ref as ArtifactRefType)
              const data = buffer.toString("base64")
              parts.push({
                type: ref.mimeType.startsWith("image/") ? "image" : "audio",
                mime: ref.mimeType,
                data,
                source: "artifact",
                artifactId: ref.id,
              })
            } catch {
              // If artifact cannot be read, skip — text content already included
            }
          } else {
            // Historical turn: provider does not support file_ref yet, so keep text metadata only.
            parts.push({ type: "text", text: `Previous ${ref.mimeType.startsWith("image/") ? "image" : "audio"} artifact omitted: artifactId=${ref.id}, mime=${ref.mimeType}` })
          }
        }
        // Other types (tool-output, file-content) — skip, text is enough
      }
    }

    // Handle audio attachments
    const attachments = msg.attachments
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.type === "audio") {
          if (isCurrentTurn) {
            try {
              const buffer = this.artifactStore.readArtifact(att.artifact as ArtifactRefType)
              const data = buffer.toString("base64")
              parts.push({
                type: "audio",
                mime: att.mimeType,
                data,
                source: "artifact",
                artifactId: att.artifact.id,
              })
            } catch {
              // Skip if artifact cannot be read
            }
          } else {
            // Historical turn: provider does not support file_ref yet, so keep text metadata only.
            parts.push({ type: "text", text: `Previous audio attachment omitted: artifactId=${att.artifact.id}, mime=${att.mimeType}, name=${att.label}` })
          }
        }
      }
    }

    return parts
  }

  private _messageForModel(
    params: { messages: ConversationStoreMessage[]; currentUserMessageId?: string },
    msg: ConversationStoreMessage,
  ): ConversationStoreMessage {
    if (msg.role !== "tool" || this._isCurrentRunToolMessage(params, msg)) return msg

    const historySummary = typeof msg.extra?.toolHistorySummary === "string"
      ? msg.extra.toolHistorySummary
      : buildToolHistorySummary({
        toolName: msg.toolName ?? "unknown",
        status: typeof msg.extra?.status === "string" ? msg.extra.status : "unknown",
        output: msg.content,
      })

    return { ...msg, content: historySummary }
  }

  private _isCurrentRunToolMessage(
    params: { messages: ConversationStoreMessage[]; currentUserMessageId?: string },
    msg: ConversationStoreMessage,
  ): boolean {
    if (!params.currentUserMessageId) return false
    const currentUserIndex = params.messages.findIndex((message) => message.id === params.currentUserMessageId)
    const messageIndex = params.messages.findIndex((message) => message.id === msg.id)
    return currentUserIndex >= 0 && messageIndex > currentUserIndex
  }

  /**
   * Enforce artifact raw byte budget: total inline image/audio bytes
   * must not exceed MAX_ARTIFACT_RAW_BYTES. If exceeded, replace earlier
   * raw artifacts with file_ref parts, keeping the last one inline.
   */
  private _enforceArtifactByteBudget(modelMessages: ModelMessage[]): void {
    let totalRawBytes = 0

    // Collect all image/audio parts with their positions
    interface ArtifactPart {
      msgIdx: number
      partIdx: number
      bytes: number
      artifactId: string
      mime: string
    }

    const parts: ArtifactPart[] = []

    for (let mi = 0; mi < modelMessages.length; mi++) {
      const content = modelMessages[mi]!.content
      for (let pi = 0; pi < content.length; pi++) {
        const part = content[pi]!
        if (part.type === "image" || part.type === "audio") {
          const bytes = Math.floor(part.data.length * 3 / 4)
          totalRawBytes += bytes
          parts.push({
            msgIdx: mi,
            partIdx: pi,
            bytes,
            artifactId: part.artifactId ?? "",
            mime: part.mime,
          })
        }
      }
    }

    if (totalRawBytes <= ContextBuilderAdapter.MAX_ARTIFACT_RAW_BYTES) {
      for (const p of parts) {
        if (p.bytes > ContextBuilderAdapter.MAX_ARTIFACT_RAW_BYTES) {
          const content = modelMessages[p.msgIdx]!.content
          content[p.partIdx] = {
            type: "text",
            text: `Raw artifact omitted because it exceeds request budget: artifactId=${p.artifactId}, mime=${p.mime}, bytes=${p.bytes}`,
          }
        }
      }
      return
    }

    // Exceeded budget: replace earlier parts with file_ref, keep the last one
    // Keep the last artifact part inline, replace all others
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!
      const content = modelMessages[p.msgIdx]!.content
      content[p.partIdx] = {
        type: "text",
        text: `Raw artifact omitted because request budget was exceeded: artifactId=${p.artifactId}, mime=${p.mime}, bytes=${p.bytes}`,
      }
    }

    const last = parts[parts.length - 1]
    if (last && last.bytes > ContextBuilderAdapter.MAX_ARTIFACT_RAW_BYTES) {
      const content = modelMessages[last.msgIdx]!.content
      content[last.partIdx] = {
        type: "text",
        text: `Raw artifact omitted because it exceeds request budget: artifactId=${last.artifactId}, mime=${last.mime}, bytes=${last.bytes}`,
      }
    }
  }

  /**
   * Rebuild messages with only the last N conversation messages.
   */
  private _shrinkToLastN(
    params: {
      systemPrompt: string
      userText: string
      messages: ConversationStoreMessage[]
      currentUserMessageId?: string
    },
    n: number,
  ): ModelMessage[] {
    const modelMessages: ModelMessage[] = []

    // System prompt
    modelMessages.push({
      role: "system",
      content: [{ type: "text", text: params.systemPrompt }],
    })

    // Summary placeholder (always present when shrinking)
    modelMessages.push({
      role: "system",
      content: [{ type: "text", text: ContextBuilderAdapter.SUMMARY_PLACEHOLDER }],
    })

    // Last N non-system messages with multimodal content
    const lastN = params.messages
      .filter((m) => m.role !== "system")
      .slice(-n)
    for (const msg of lastN) {
      const isCurrentTurn = params.currentUserMessageId != null && msg.id === params.currentUserMessageId
      const messageForModel = this._messageForModel(params, msg)
      const role = msg.role as "user" | "assistant" | "tool"
      modelMessages.push({
        role,
        toolCallId: messageForModel.toolCallId,
        content: this._buildContentParts(messageForModel, isCurrentTurn),
      })
    }

    // Current user text
    if (params.userText) {
      const lastMsg = params.messages[params.messages.length - 1]
      const alreadyIncluded = lastMsg?.role === "user" && lastMsg.content === params.userText
      if (!alreadyIncluded) {
        modelMessages.push({
          role: "user",
          content: [{ type: "text", text: params.userText }],
        })
      }
    }

    return modelMessages
  }

  /**
   * Estimate total tokens for an array of ModelMessage objects.
   * Uses the exported `estimateTokens` (chars / 3.5 heuristic) plus
   * a small per-message overhead for role/metadata framing.
   */
  private _estimateMessagesTokens(messages: ModelMessage[]): number {
    let total = 0
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.type === "text") {
          total += estimateTokens(part.text)
        } else if (part.type === "image" || part.type === "audio") {
          // Rough estimate: ~2 tokens per byte for base64 data
          total += Math.ceil(part.data.length / 2)
        }
        // file_ref parts are negligible
      }
      // Per-message framing overhead (~4 tokens)
      total += 4
    }
    return total
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
      model: this.runModels.get(params.runId) ?? this.model,
      previousResponseId: params.previousResponseId,
      toolResult: params.toolResult,
      tools: params.tools,
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
  }
}

/**
 * ToolManager backed by ToolRegistry + AgentService execution + PermissionService.
 *
 * executeToolCall() flow:
 *   1. Construct AgentAction
 *   2. Call PermissionService.check([action])
 *   3. Denied → return CanonicalToolResult with status="denied", output/summary containing reason
 *   4. Approved → execute only the approved actions via AgentService.executeMany
 */
class ToolManagerAdapter implements ToolManager {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly agent: AgentService,
    private readonly permissions: PermissionService,
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

    // 1. Check permission via PermissionService
    const decision = await this.permissions.check([action])

    // 2. Denied → return denied result
    if (decision.status === "denied") {
      const reason = decision.reason ?? "Tool execution denied by permission policy"
      return {
        callId: call.callId,
        name: call.name,
        status: "denied",
        output: JSON.stringify({ status: "denied", summary: reason, reason }),
        summary: reason,
      }
    }

    // 3. Approved → execute only the approved actions
    const results = await this.agent.executeMany(decision.actions)
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

function normalizeMessageContentToText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("")
}
