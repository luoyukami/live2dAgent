import type {
  AgentMessage,
  AgentAction,
  ToolResult,
  AgentEvent,
  AgentMessageMetadata,
  Emotion,
  MultimodalContent,
  AudioContextAttachment,
  ArtifactRef,
} from "./types.js"
import type { EmotionSettings } from "@live2d-agent/shared"
import type { ModelAdapter } from "./model-adapter.js"
import type { StreamingCallbacks } from "./model-adapter.js"
import type { ToolRegistry } from "./tool-registry.js"
import { EventBus } from "./events.js"
import { parseEmotionTag } from "./emotion-parser.js"
import { buildToolHistorySummary, isToolHistorySummary } from "./tools/tool-history-summary.js"

/* ------------------------------------------------------------------ */
/*  Interfaces that MUST be implemented by the host environment        */
/*  (e.g. Electron main process).                                     */
/* ------------------------------------------------------------------ */

/** Executes approved tool actions and returns results. */
export interface ToolRuntime {
  executeMany(actions: AgentAction[]): Promise<ToolResult[]>
}

/** Decides whether a set of tool actions may proceed. */
export interface PermissionController {
  check(
    actions: AgentAction[],
  ): Promise<{
    status: "approved" | "denied"
    actions: AgentAction[]
    reason?: string
  }>
}

/** Persistent store for trace replay / debugging. */
export interface TraceStore {
  append(event: AgentEvent): void
}

export interface AgentSessionOptions {
  maxSteps?: number
  /**
   * Emotion settings snapshot. Required when the host wants the session to
   * parse trailing `<emotion />` tags, attach `metadata.emotion`, and emit
   * `emotion.set` events. When omitted the session treats the system as
   * disabled (no parsing, no events).
   */
  emotion?: EmotionSettings
  /**
   * When true the session passes streaming callbacks to `ModelAdapter.query()`
   * and emits `message.created` / `message.delta` / `message.completed` events
   * as text arrives. The final processed message is still added via
   * `addMessage()` so that `message.added` events fire for backward
   * compatibility (TTS, UI, etc.).
   *
   * When false (the default), the adapter is called without streaming
   * callbacks and behaviour is identical to previous versions.
   */
  streamingEnabled?: boolean
}

/* ------------------------------------------------------------------ */
/*  AgentSession — the core agent loop                                 */
/* ------------------------------------------------------------------ */

/**
 * Manages one conversation session.
 *
 * The loop implements:
 *   user message → model query → tool calls → permission check →
 *   execution → observation → repeat until idle or task.finish
 *
 * Designed to be runtime-agnostic: no Node, Electron, or DOM APIs.
 */
export class AgentSession {
  messages: AgentMessage[] = []
  private readonly maxSteps: number
  private readonly emotion: EmotionSettings
  private readonly streamingEnabled: boolean

  constructor(
    private model: ModelAdapter,
    private tools: ToolRegistry,
    private runtime: ToolRuntime,
    private approval: PermissionController,
    private trace: TraceStore,
    private events: EventBus,
    options: AgentSessionOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 20
    this.streamingEnabled = options.streamingEnabled ?? false
    // Default to "system disabled" — safer for callers that don't pass
    // emotion settings (the system is opt-in from the host's perspective).
    this.emotion = options.emotion ?? {
      enabled: false,
      injectPrompt: false,
      defaultEmotion: "neutral",
      stripTagWhenDisabled: true,
    }
  }

  /**
   * Process a new user message through the full agent loop.
   * Returns when the agent reaches an idle state.
   *
   * Accepts an optional list of context attachments (audio, future
   * screenshot, etc.). Attachments are stored on the AgentMessage so the
   * ModelAdapter can resolve them into multimodal content parts.
   */
  async runUserMessage(
    textOrInput: string | { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: ArtifactRef[] },
  ): Promise<void> {
    const text = typeof textOrInput === "string" ? textOrInput : textOrInput.text
    const attachments = typeof textOrInput === "string" ? undefined : textOrInput.attachments
    const artifactRefs = typeof textOrInput === "string" ? undefined : textOrInput.artifactRefs

    this.compactHistoricalToolMessages()

    const extra: Record<string, unknown> = {}
    if (artifactRefs && artifactRefs.length > 0) {
      extra.artifactRefs = artifactRefs
    }

    this.addMessage({
      id: this.generateId("msg"),
      role: "user",
      content: text,
      createdAt: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    })

    for (let step = 1; step <= this.maxSteps; step += 1) {
      this.emit({ type: "agent.thinking" })

      const streamingCallbacks = this.buildStreamingCallbacks()
      const assistantMessage = await this.model.query({
        messages: this.messages,
        tools: this.tools.getDefinitions(),
        ...(streamingCallbacks ? { callbacks: streamingCallbacks } : {}),
      })

      // If streaming was active, emit message.completed now that the full
      // response has been received from the adapter.
      if (streamingCallbacks) {
        this.emit({ type: "message.completed", messageId: assistantMessage.id })
      }

      // Parse the trailing <emotion /> tag (if any) BEFORE the message enters
      // the conversation history. This guarantees:
      //   1. Chat UI never sees the raw tag.
      //   2. Tool observations and later steps only see the cleaned text.
      //   3. The emotion metadata is bound to this specific assistant message.
      const processed = this.applyEmotionToAssistantMessage(assistantMessage)
      this.addMessage(processed)
      this.maybeEmitEmotion(processed)

      const actions = processed.actions ?? []
      const actionsToHandle = this.actionsToHandle(actions)

      /* ---- No tool calls → idle ---- */
      if (actionsToHandle.length === 0) {
        this.emit({ type: "agent.idle" })
        break
      }

      /* ---- Permission check ---- */
      const decision = await this.approval.check(actionsToHandle)

      if (decision.status === "denied") {
        const results = actionsToHandle.map((action) => this.deniedResult(action, decision.reason ?? "User denied this tool-call round"))
        for (const result of results) this.emit({ type: "tool.error", result })
        for (const obs of this.model.formatObservations(results)) this.addMessage(obs)
        continue
      }

      /* ---- Emit tool-started events ---- */
      for (const action of decision.actions) {
        this.emit({ type: "tool.started", action })
      }

      /* ---- Execute ---- */
      const executedResults = await this.runtime.executeMany(decision.actions)
      const results = this.completeResults(actionsToHandle, executedResults)

      /* ---- Emit tool-finished / tool-error events ---- */
      for (const result of results) {
        this.emit(
          result.ok
            ? { type: "tool.finished", result }
            : { type: "tool.error", result },
        )
      }

      /* ---- Format & append observations ---- */
      const observations = this.model.formatObservations(results)
      for (const obs of observations) {
        this.addMessage(obs)
      }

      /* ---- Check for task.finish ---- */
      if (actionsToHandle.some((a) => a.tool === "task.finish")) {
        this.emit({ type: "agent.idle" })
        break
      }

      if (step === this.maxSteps) {
        this.addMessage({
          id: this.generateId("msg"),
          role: "user",
          content: `Step limit (${this.maxSteps}) exceeded. Ask the user whether to continue.`,
          createdAt: Date.now(),
          extra: { type: "step_limit.exceeded", maxSteps: this.maxSteps },
        })
        this.emit({ type: "agent.idle" })
      }
    }
  }

  /**
   * Process a one-off user-like input without appending that input to session
   * history. The assistant's reply is appended/emitted normally.
   */
  async runTransientUserMessage(
    textOrInput: string | { text: string; attachments?: AudioContextAttachment[]; artifactRefs?: ArtifactRef[] },
  ): Promise<void> {
    const text = typeof textOrInput === "string" ? textOrInput : textOrInput.text
    const attachments = typeof textOrInput === "string" ? undefined : textOrInput.attachments
    const artifactRefs = typeof textOrInput === "string" ? undefined : textOrInput.artifactRefs

    this.compactHistoricalToolMessages()

    const extra: Record<string, unknown> = {}
    if (artifactRefs && artifactRefs.length > 0) extra.artifactRefs = artifactRefs

    const transientUserMessage: AgentMessage = {
      id: this.generateId("msg_transient"),
      role: "user",
      content: text,
      createdAt: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }

    this.emit({ type: "agent.thinking" })
    const streamingCallbacks = this.buildStreamingCallbacks()
    const assistantMessage = await this.model.query({
      messages: [...this.messages, transientUserMessage],
      tools: [],
      ...(streamingCallbacks ? { callbacks: streamingCallbacks } : {}),
    })
    if (streamingCallbacks) {
      this.emit({ type: "message.completed", messageId: assistantMessage.id })
    }
    const processed = this.applyEmotionToAssistantMessage(assistantMessage)
    this.addMessage(processed)
    this.maybeEmitEmotion(processed)
    this.emit({ type: "agent.idle" })
  }

  /* ---- internal helpers ---- */

  /**
   * Build streaming callbacks when streaming is enabled.
   * Returns `undefined` when streaming is disabled so callers can skip.
   *
   * The returned `onTextDelta` callback:
   *  - On the first delta, emits `message.created` with the adapter's id.
   *  - On every delta (including the first), emits `message.delta`.
   */
  private buildStreamingCallbacks(): StreamingCallbacks | undefined {
    if (!this.streamingEnabled) return undefined
    let created = false
    return {
      onTextDelta: (messageId: string, delta: string) => {
        if (!created) {
          created = true
          this.emit({
            type: "message.created",
            message: { id: messageId, role: "assistant", createdAt: Date.now() },
          })
        }
        this.emit({ type: "message.delta", messageId, delta })
      },
    }
  }

  private addMessage(message: AgentMessage): void {
    this.messages.push(message)
    this.emit({ type: "message.added", message })
  }

  private compactHistoricalToolMessages(): void {
    for (const message of this.messages) {
      if (message.role !== "tool" || typeof message.content !== "string") continue
      if (isToolHistorySummary(message.content)) continue

      const toolName = typeof message.extra?.toolName === "string" ? message.extra.toolName : "unknown"
      const status = typeof message.extra?.ok === "boolean"
        ? (message.extra.ok ? "ok" : "error")
        : "unknown"
      const existingSummary = typeof message.extra?.toolHistorySummary === "string"
        ? message.extra.toolHistorySummary
        : undefined
      const historySummary = existingSummary ?? buildToolHistorySummary({
        toolName,
        status,
        output: message.content,
      })

      message.content = historySummary
      message.extra = { ...message.extra, toolHistorySummary: historySummary, toolHistoryCompacted: true }
    }
  }

  private emit(event: AgentEvent): void {
    this.trace.append(event)
    this.events.emit(event)
  }

  private completeResults(actions: AgentAction[], executedResults: ToolResult[]): ToolResult[] {
    const byActionId = new Map(executedResults.map((result) => [result.actionId, result]))
    return actions.map((action) => byActionId.get(action.id) ?? this.deniedResult(action, "Action was not approved"))
  }

  private actionsToHandle(actions: AgentAction[]): AgentAction[] {
    const finishAction = actions.find((action) => action.tool === "task.finish")
    return finishAction ? [finishAction] : actions
  }

  private deniedResult(action: AgentAction, reason: string): ToolResult {
    const now = Date.now()
    return {
      actionId: action.id,
      providerToolCallId: action.providerToolCallId,
      tool: action.tool,
      ok: false,
      content: reason,
      error: { code: "ACTION_NOT_APPROVED", message: reason, recoverable: true },
      startedAt: now,
      endedAt: now,
    }
  }

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }

  /* ---- Emotion pipeline (see docs/情绪功能开发需求.md §11) ---- */

  /**
   * Strip the trailing `<emotion />` tag from the assistant message and
   * attach the parsed emotion to `metadata`. Pure transformation; never
   * mutates the original input.
   */
  private applyEmotionToAssistantMessage(message: AgentMessage): AgentMessage {
    if (message.role !== "assistant") return message
    if (!assistantMessageHasVisibleText(message)) {
      // Tool-only (or otherwise empty) assistant messages must NOT generate
      // an emotion metadata. They are not visible to the user as text replies
      // and tagging them would silently overwrite the last emotion every time
      // the model reaches for a tool.
      return message
    }

    const result = this.parseAssistantContent(message.content)
    if (!result) {
      // Either the system is fully disabled (no parsing wanted) or the
      // content is non-text (no trailing tag to strip). Leave as-is.
      return message
    }

    const metadata: AgentMessageMetadata = {
      ...(message.metadata ?? {}),
      emotion: result.emotion,
      emotionSource: result.emotionSource,
    }
    if (result.rawEmotionTag !== undefined) metadata.rawEmotionTag = result.rawEmotionTag
    if (result.parseWarning !== undefined) metadata.parseWarning = result.parseWarning

    return {
      ...message,
      content: result.content,
      metadata,
    }
  }

  /**
   * Parse the trailing emotion tag out of the assistant content.
   * Returns `null` when the system is disabled (so the caller can skip work).
   */
  private parseAssistantContent(
    content: string | MultimodalContent[],
  ): {
    content: string | MultimodalContent[]
    emotion: Emotion
    emotionSource: "llm-tag" | "fallback" | "disabled"
    rawEmotionTag?: string
    parseWarning?: string
  } | null {
    if (!this.emotion) return null

    // String content — straightforward parse.
    if (typeof content === "string") {
      const parsed = parseEmotionTag(content, {
        enabled: this.emotion.enabled,
        defaultEmotion: this.emotion.defaultEmotion,
        stripTagWhenDisabled: this.emotion.stripTagWhenDisabled,
      })
      return {
        content: parsed.visibleText,
        emotion: parsed.emotion,
        emotionSource: parsed.emotionSource,
        rawEmotionTag: parsed.rawEmotionTag,
        parseWarning: parsed.parseWarning,
      }
    }

    // Multimodal — only touch the last text block. Other blocks untouched.
    const blocks = content
    let lastTextIndex = -1
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i]?.type === "text") {
        lastTextIndex = i
        break
      }
    }

    if (lastTextIndex === -1) {
      // No text block at all — fall back to default emotion, do not strip.
      return {
        content,
        emotion: this.emotion.defaultEmotion,
        emotionSource: this.emotion.enabled ? "fallback" : "disabled",
      }
    }

    const target = blocks[lastTextIndex]!
    const rawText = target.text ?? ""
    const parsed = parseEmotionTag(rawText, {
      enabled: this.emotion.enabled,
      defaultEmotion: this.emotion.defaultEmotion,
      stripTagWhenDisabled: this.emotion.stripTagWhenDisabled,
    })

    // Build a new blocks array only when something actually changed.
    const stripped = parsed.rawEmotionTag !== undefined
    const newText = stripped ? parsed.visibleText : rawText
    if (!stripped && newText === rawText) {
      return {
        content,
        emotion: parsed.emotion,
        emotionSource: parsed.emotionSource,
        rawEmotionTag: parsed.rawEmotionTag,
        parseWarning: parsed.parseWarning,
      }
    }

    const nextBlocks = blocks.slice()
    nextBlocks[lastTextIndex] = { ...target, text: newText }
    return {
      content: nextBlocks,
      emotion: parsed.emotion,
      emotionSource: parsed.emotionSource,
      rawEmotionTag: parsed.rawEmotionTag,
      parseWarning: parsed.parseWarning,
    }
  }

  /**
   * Emit an `emotion.set` event for the parsed assistant message.
   * - When the system is disabled, we DO NOT emit (per docs §12.3).
   * - When the assistant message carries no visible text (e.g. tool-only
   *   `content: ""` with `actions`), we DO NOT emit either — the emotion
   *   pipeline should never be triggered by non-visible assistant turns.
   * - The event always carries the assistant message id so the renderer can
   *   correlate it back to the bubble in the chat.
   */
  private maybeEmitEmotion(message: AgentMessage): void {
    if (message.role !== "assistant") return
    if (!assistantMessageHasVisibleText(message)) return
    const meta = message.metadata
    if (!meta || meta.emotion === undefined || meta.emotionSource === undefined) return
    if (meta.emotionSource === "disabled") return
    this.emit({
      type: "emotion.set",
      emotion: meta.emotion,
      source: meta.emotionSource,
      messageId: message.id,
    })
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * True iff the assistant message carries visible text. We use a permissive
 * definition: any non-empty text in `content` (string or text block) counts.
 * Tool-only messages (`content: ""` + `actions`) and tool-only multimodal
 * variants return false.
 */
function assistantMessageHasVisibleText(message: AgentMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0
  }
  if (!Array.isArray(message.content)) return false
  return message.content.some(
    (block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  )
}
