import { clipboard, desktopCapturer } from "electron"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { AgentSession, AssistantRuntime, ContextManager, ConversationManager, DefaultProviderRuntimeRegistry, EventBus, RunController, ToolRegistry, WsSessionManager, composePromptPresetInstructions, composeSystemPrompt, isEmotionPromptInjected, ToolResultLimiter, WS_RUNTIME_CONSTANTS, estimateTokens, sanitizeTextForTts, extractTtsInstruction, isTtsInstructionInjected, type AgentEvent, type AgentAction, type AgentRuntimeEvent, type ArtifactWriter, type ToolResult, type ToolRuntime, type ToolArtifact, type ConversationStore, type ConversationStoreMessage, type ContextBuilder, type ToolManager, type ToolValidationResult, type CanonicalToolDefinition, type ModelToolCall, type ValidatedToolCall, type CanonicalToolResult, type CanonicalCreateInput, type CanonicalToolContinuationInput, type AssistantRuntimeEvent, type ProviderRuntime, type ModelMessage, type ModelContentPart, type AgentMessageMetadata, type AgentMessage } from "@live2d-agent/agent-core"
import { OpenAiCompatibleAdapter, OpenAiCompatibleWsClient, MimoWsRuntime } from "@live2d-agent/model-openai-compatible"
import { createDefaultTools, type RuntimeToolContext } from "@live2d-agent/tools"
import type { ArtifactRef, AudioArtifactRef, AudioContextAttachment, DebugEmotionInfo, Emotion, MessageAudioState } from "@live2d-agent/shared"
import { DEFAULT_TTS_EMOTION_INSTRUCTIONS } from "@live2d-agent/shared"
import type { EmotionSource } from "@live2d-agent/agent-core"
import type { ArtifactRef as ArtifactRefType } from "@live2d-agent/shared"
import type { ArtifactStore } from "./artifact-store.js"
import type { PermissionService } from "./permission-service.js"
import type { PromptService } from "./prompt-service.js"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"
import type { TtsService } from "./tts/tts-service.js"
import { AgentRuntimeEventBridge } from "../agent-runtime-event-bridge.js"
import { resolveRuntimeMode } from "../runtime-mode.js"

export interface AgentServiceDeps {
  settings: SettingsService
  trace: TraceService
  permissions: PermissionService
  artifacts: ArtifactStore
  prompts: PromptService
  tts: TtsService
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
    const requestedMode = settings.agent.runtimeMode ?? "ws"
    const resolution = resolveRuntimeMode(requestedMode, settings.openaiBaseUrl)
    if (resolution.fallbackReason) {
      console.warn(`[agent-service] ${resolution.fallbackReason}`)
    }
    this.runtimeMode = resolution.mode

    const definitions = this.deps.prompts.applyToolOverrides(createDefaultTools())
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
    const contextBuilder = new ContextBuilderAdapter(systemPrompt, settings.openaiModel, this.deps.artifacts)
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
    const base = composePromptPresetInstructions(settings.promptPresets)
    return composeSystemPrompt(base, settings.emotion, settings.tts)
  }

  async sendUserMessage(input: string | { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: ArtifactRefType[]; conversationId?: string }): Promise<void> {
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

    if (this.runtimeMode === "http-legacy") {
      if (!this.session) this.reconfigure()
      await this.session?.runUserMessage(input)
      return
    }

    // The WS runtime does not emit renderer-facing user messages itself.
    // The legacy AgentSession path does, so keep this emit WS-only to avoid
    // rendering the same user input twice with different generated IDs.
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

    // Default WS runtime path
    if (!this.assistantRuntime) this.reconfigure()

    const artifactRefs = typeof input === "object" ? input.artifactRefs : undefined

    // Pass full text, attachments, and artifactRefs to AssistantRuntime
    await this.assistantRuntime?.sendUserMessage(conversationId, {
      text,
      attachments: attachments as any,
      artifactRefs: artifactRefs as any,
    })
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
  ): { messageId: string; text: string; voiceId: string; mode: "standard" | "emotion_enhanced"; emotionControlMode: "default_mapping" | "llm_controlled"; instruction?: string; speed: number; seed: number } | null {
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
        instruction = DEFAULT_TTS_EMOTION_INSTRUCTIONS[emotionResult.emotion] ?? DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral
      } else {
        // llm_controlled mode — extract instruction from the message
        const ttsResult = extractTtsInstruction(rawContent)
        if (ttsResult) {
          instruction = ttsResult.instruction
          this.ttsDebug.lastInstructionInjected = true
        } else {
          // Fallback to default mapping if no instruction found
          const emotionResult = this.parseEmotionFromMessage(rawContent, metadata)
          instruction = DEFAULT_TTS_EMOTION_INSTRUCTIONS[emotionResult.emotion] ?? DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral
        }
      }
    }

    return {
      messageId,
      text: cleanedText,
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

      const result = await this.deps.tts.generate(req)

      this.ttsDebug.lastResponseDetails = {
        ok: result.ok,
        audioPath: result.audioPath,
        error: result.error,
        durationMs: Date.now() - startedAt,
      }

      if (result.ok && result.audioPath) {
        this.ttsDebug.lastAutoGenerateSuccess = true
        this.ttsDebug.lastAutoGenerateError = undefined
        const audioUrl = pathToFileURL(result.audioPath).href
        this.emit({ type: "tts.ready", messageId, audioPath: result.audioPath, audioUrl })
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
    // Look up the original message to get its content and metadata
    const convId = this.activeConversationId ?? ""
    const allMessages = this.conversationManager?.getMessages(convId) ?? []
    const message = allMessages.find((m) => m.id === messageId)

    this.ttsDebug.lastRegenerateLookup = {
      messageId,
      found: !!message,
      conversationId: convId,
      totalMessages: allMessages.length,
      error: message ? undefined : `Message ${messageId} not found in conversation ${convId} (${allMessages.length} messages)`,
    }

    if (!message) {
      this.emit({ type: "tts.error", messageId, error: "找不到原始消息" })
      return
    }
    const rawContent = normalizeMessageContentToText(message.content)
    await this.generateTtsForMessage({
      messageId,
      rawContent,
      metadata: (message as any).metadata,
    })
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
    if (event.type === "message.added" && event.message.role === "assistant" && !event.message.extra?.error) {
      this.scheduleTtsAutoGenerationForMessage(event.message)
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
  ): ConversationStoreMessage[] {
    const msgs = this.mgr.getMessages(conversationId)
    const conv = (this.mgr as any).getConversation(conversationId)
    if (!conv) return msgs
    return msgs.map((m: { id: string; role: "user" | "assistant"; content: string; createdAt: number }) => {
      const stored = conv.messages.find((s: { id: string }) => s.id === m.id)
      if (stored && (stored.attachments || stored.extra)) {
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          attachments: stored.attachments,
          extra: stored.extra,
        }
      }
      return { id: m.id, role: m.role, content: m.content }
    })
  }

  hasConversation(conversationId: string): boolean {
    return this.mgr.getConversation(conversationId) !== undefined
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

  constructor(
    private readonly systemPrompt: string,
    private readonly model: string,
    private readonly artifactStore: ArtifactStore,
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

    return {
      conversationId: params.conversationId,
      runId: params.runId,
      model: this.model,
      remoteResponseId: params.remoteResponseId ?? null,
      messages: modelMessages,
      tools: params.tools,
      toolChoice: "auto",
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
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
      const role = msg.role as "user" | "assistant" | "tool"
      modelMessages.push({
        role,
        content: this._buildContentParts(msg, isCurrentTurn),
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
      const role = msg.role as "user" | "assistant" | "tool"
      modelMessages.push({
        role,
        content: this._buildContentParts(msg, isCurrentTurn),
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
