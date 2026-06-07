/**
 * RunController — orchestrates a single user-message → model-response cycle.
 *
 * Phase 1 scope: plain-text streaming only.
 *   - enqueueUserMessage: queue or start a run.
 *   - createResponse via ModelWsClient.
 *   - Accumulate text deltas, flush on interval / completion.
 *   - Update conversation messages and remoteContextId.
 *   - Emit AgentRuntimeEvent for each milestone.
 *
 * Tool calls, cancellation, and ContextManager integration are Phase 2+.
 *
 * See docs/ws_model_communication_architecture.md §3.1 (RunController), §10.
 */
import type {
  AgentRun,
  AgentRuntimeEvent,
  RuntimeErrorPayload,
} from "../ws/ws-types.js"
import type {
  ModelWsClient,
  ModelWsEvent,
} from "../ws/model-ws-client.js"
import type { ConversationManager } from "../conversation/conversation-manager.js"
import type { WsSessionManager } from "../ws/ws-session-manager.js"
import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RuntimeEventCallback = (event: AgentRuntimeEvent) => void
export type RuntimeEventUnsubscribe = () => void

/* ------------------------------------------------------------------ */
/*  Queued message                                                     */
/* ------------------------------------------------------------------ */

interface QueuedMessage {
  content: string
  conversationId: string
}

/* ------------------------------------------------------------------ */
/*  RunController                                                      */
/* ------------------------------------------------------------------ */

export class RunController {
  private runs = new Map<string, AgentRun>()
  private queues = new Map<string, QueuedMessage[]>()
  private eventListeners = new Set<RuntimeEventCallback>()

  /** Accumulated delta text for the current run. */
  private currentDelta = ""
  /** The assistant message ID being accumulated into. */
  private currentMessageId: string | null = null
  /** The run ID whose delta is being accumulated. */
  private currentRunId: string | null = null
  /** Timer handle for periodic delta flush. */
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

  private modelWsUnsubscribe: (() => void) | null = null

  constructor(
    private conversationManager: ConversationManager,
    private wsSessionManager: WsSessionManager,
    private modelWsClient: ModelWsClient,
  ) {
    // Subscribe to model WS events
    this.modelWsUnsubscribe = this.modelWsClient.onEvent((event) =>
      this.handleModelWsEvent(event),
    )
  }

  /* ---- Event bus ---- */

  onEvent(callback: RuntimeEventCallback): RuntimeEventUnsubscribe {
    this.eventListeners.add(callback)
    return () => {
      this.eventListeners.delete(callback)
    }
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("[RunController] listener error:", err)
      }
    }
  }

  /* ---- Public API ---- */

  /**
   * Enqueue (or immediately start) a user message for the given conversation.
   *
   * - If there is no active run, starts one immediately.
   * - If an active run exists, the message is queued.
   * - If the queue is full, throws an error.
   */
  async enqueueUserMessage(conversationId: string, text: string): Promise<void> {
    const conv = this.conversationManager.getConversation(conversationId)
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`)
    }

    // Check if there's an active run
    const activeRun = this.getActiveRun(conversationId)
    if (activeRun) {
      // Queue the message
      const queue = this.getOrCreateQueue(conversationId)
      if (queue.length >= WS_RUNTIME_CONSTANTS.MAX_QUEUED_USER_MESSAGES_PER_CONVERSATION) {
        throw new Error("Conversation queue is full")
      }
      queue.push({ content: text, conversationId })
      // Emit informational queued event
      this.emit({ type: "run.queued", conversationId, runId: `${conversationId}_q_${Date.now()}` })
      return
    }

    // No active run — start immediately
    await this.startRun(conversationId, text)
  }

  /**
   * Cancel the currently active run for a conversation.
   */
  async cancelRun(conversationId: string): Promise<void> {
    const run = this.getActiveRun(conversationId)
    if (!run) return

    run.status = "cancelling"

    // Tell the model to cancel
    const responseId = this.wsSessionManager.getActiveResponseId(conversationId)
    if (responseId) {
      try {
        await this.modelWsClient.cancelResponse({ responseId })
      } catch {
        // Non-critical — proceed with local cancellation
      }
    }

    // Flush any pending delta
    this.flushDelta()

    // Mark cancelled
    run.status = "cancelled"
    run.completedAt = Date.now()
    run.updatedAt = Date.now()

    this.wsSessionManager.clearActiveRun(conversationId)
    this.wsSessionManager.clearActiveResponse(conversationId)

    this.emit({ type: "run.cancelled", conversationId, runId: run.id })
    this.clearDeltaState()
  }

  /** Dispose all resources. */
  dispose(): void {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = null
    }
    if (this.modelWsUnsubscribe) {
      this.modelWsUnsubscribe()
      this.modelWsUnsubscribe = null
    }
    this.eventListeners.clear()
    this.queues.clear()
    this.runs.clear()
    this.clearDeltaState()
  }

  /* ---- Run execution ---- */

  /**
   * Start a new run immediately.
   *
   * Flow:
   *   1. Append user message to conversation
   *   2. Create AgentRun record
   *   3. Ensure WS session is ready
   *   4. Create assistant message placeholder
   *   5. Call ModelWsClient.createResponse with current messages
   */
  private async startRun(conversationId: string, text: string): Promise<void> {
    // 1. Append user message
    const userMessage = this.conversationManager.appendUserMessage(conversationId, text)
    if (!userMessage) throw new Error("Failed to append user message")

    // 2. Create run
    const now = Date.now()
    const run: AgentRun = {
      id: this.generateId("run"),
      conversationId,
      status: "running",
      userMessageId: userMessage.id,
      assistantMessageId: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      stepIndex: 0,
      toolCallCount: 0,
    }
    this.runs.set(run.id, run)
    this.emit({ type: "run.started", conversationId, runId: run.id })

    // 3. Ensure WS ready
    await this.wsSessionManager.ensureReady(conversationId)

    // 4. Create assistant message placeholder
    const assistantMessage = this.conversationManager.appendAssistantMessage(conversationId)
    if (!assistantMessage) {
      run.status = "failed"
      run.completedAt = Date.now()
      this.emit({
        type: "run.failed",
        conversationId,
        runId: run.id,
        error: { code: "internal_error", message: "Failed to create assistant message", retryable: false },
      })
      return
    }

    run.assistantMessageId = assistantMessage.id
    run.updatedAt = Date.now()
    this.wsSessionManager.setActiveRun(conversationId, run.id)

    // Setup delta accumulation state
    this.currentMessageId = assistantMessage.id
    this.currentRunId = run.id
    this.currentDelta = ""

    this.emit({
      type: "assistant.message.created",
      conversationId,
      runId: run.id,
      messageId: assistantMessage.id,
    })

    // 5. Build messages for the model
    const messages = this.conversationManager.getMessages(conversationId)
    const modelMessages = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))

    // Include remote context if available
    const remoteContextId = this.wsSessionManager.getRemoteContextId(conversationId)

    // Call createResponse
    try {
      await this.modelWsClient.createResponse({
        messages: modelMessages,
        ...(remoteContextId ? { remoteContextId } : {}),
      })
    } catch (err) {
      run.status = "failed"
      run.completedAt = Date.now()
      this.clearDeltaState()
      this.wsSessionManager.clearActiveRun(conversationId)
      this.emit({
        type: "run.failed",
        conversationId,
        runId: run.id,
        error: {
          code: "create_response_failed",
          message: err instanceof Error ? err.message : "Unknown error",
          retryable: true,
          cause: err,
        },
      })
    }
  }

  /* ---- ModelWsEvent handler ---- */

  private handleModelWsEvent(event: ModelWsEvent): void {
    switch (event.type) {
      case "response.created": {
        this.wsSessionManager.setActiveResponse(
          this.currentRunId
            ? this.runs.get(this.currentRunId)?.conversationId ?? ""
            : "",
          event.responseId,
        )
        if (event.remoteContextId && this.currentRunId) {
          const run = this.runs.get(this.currentRunId)
          if (run) {
            this.wsSessionManager.setRemoteContextId(run.conversationId, event.remoteContextId)
          }
        }
        break
      }

      case "response.text.delta": {
        if (!this.currentMessageId || !this.currentRunId) break

        this.currentDelta += event.delta

        // Start flush timer if not already running
        if (!this.deltaFlushTimer) {
          this.deltaFlushTimer = setTimeout(
            () => this.flushDelta(),
            WS_RUNTIME_CONSTANTS.ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
          )
        }

        // Immediate flush if accumulated text is large
        if (this.currentDelta.length >= 512) {
          this.flushDelta()
        }
        break
      }

      case "response.completed": {
        if (!this.currentRunId) break
        const run = this.runs.get(this.currentRunId)
        if (!run) break

        // Flush remaining delta
        this.flushDelta()

        // Save remote context
        if (event.remoteContextId) {
          this.conversationManager.setLastRemoteContextId(
            run.conversationId,
            event.remoteContextId,
          )
          this.wsSessionManager.setRemoteContextId(
            run.conversationId,
            event.remoteContextId,
          )
        }

        // Complete the run
        this.completeCurrentRun()
        break
      }

      case "response.cancelled": {
        if (!this.currentRunId) break
        const run = this.runs.get(this.currentRunId)
        if (!run) break
        // Flush any remaining text before marking cancelled
        this.flushDelta()
        run.status = "cancelled"
        run.completedAt = Date.now()
        this.emit({
          type: "run.cancelled",
          conversationId: run.conversationId,
          runId: run.id,
        })
        this.cleanupAfterRun(run.conversationId)
        break
      }

      case "error": {
        if (!this.currentRunId) break
        const run = this.runs.get(this.currentRunId)
        if (!run) break
        this.failCurrentRun(event.error)
        break
      }
    }
  }

  /* ---- Delta flushing ---- */

  private flushDelta(): void {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = null
    }

    if (this.currentDelta.length === 0) return
    if (!this.currentMessageId || !this.currentRunId) return

    const run = this.runs.get(this.currentRunId)
    if (!run) return

    const text = this.currentDelta
    this.currentDelta = ""

    // Append to the conversation message
    this.conversationManager.updateAssistantMessage(
      run.conversationId,
      this.currentMessageId,
      this.getCurrentAssistantContent(run.conversationId, this.currentMessageId) + text,
    )

    this.emit({
      type: "assistant.message.delta",
      conversationId: run.conversationId,
      runId: run.id,
      messageId: this.currentMessageId,
      text,
    })
  }

  /** Get the current content of an assistant message. */
  private getCurrentAssistantContent(conversationId: string, messageId: string): string {
    const conv = this.conversationManager.getConversation(conversationId)
    if (!conv) return ""
    const msg = conv.messages.find((m) => m.id === messageId)
    return msg?.content ?? ""
  }

  /* ---- Run completion ---- */

  private completeCurrentRun(): void {
    if (!this.currentRunId) return
    const run = this.runs.get(this.currentRunId)
    if (!run) return

    run.status = "completed"
    run.completedAt = Date.now()
    run.updatedAt = Date.now()

    this.emit({
      type: "assistant.message.completed",
      conversationId: run.conversationId,
      runId: run.id,
      messageId: this.currentMessageId ?? "",
    })

    this.emit({
      type: "run.completed",
      conversationId: run.conversationId,
      runId: run.id,
    })

    this.cleanupAfterRun(run.conversationId)
  }

  private failCurrentRun(error: RuntimeErrorPayload): void {
    if (!this.currentRunId) return
    const run = this.runs.get(this.currentRunId)
    if (!run) return

    // Flush any remaining delta before failing
    this.flushDelta()

    run.status = "failed"
    run.completedAt = Date.now()
    run.updatedAt = Date.now()

    this.emit({
      type: "run.failed",
      conversationId: run.conversationId,
      runId: run.id,
      error,
    })

    this.cleanupAfterRun(run.conversationId)
  }

  private cleanupAfterRun(conversationId: string): void {
    this.clearDeltaState()
    this.wsSessionManager.clearActiveRun(conversationId)
    this.wsSessionManager.clearActiveResponse(conversationId)

    // Process next queued message
    this.processNextInQueue(conversationId)
  }

  private clearDeltaState(): void {
    this.currentDelta = ""
    this.currentMessageId = null
    this.currentRunId = null
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = null
    }
  }

  /* ---- Queue processing ---- */

  private getOrCreateQueue(conversationId: string): QueuedMessage[] {
    let queue = this.queues.get(conversationId)
    if (!queue) {
      queue = []
      this.queues.set(conversationId, queue)
    }
    return queue
  }

  private async processNextInQueue(conversationId: string): Promise<void> {
    const queue = this.queues.get(conversationId)
    if (!queue || queue.length === 0) return

    const next = queue.shift()!
    if (queue.length === 0) {
      this.queues.delete(conversationId)
    }

    try {
      await this.startRun(conversationId, next.content)
    } catch (err) {
      console.error("[RunController] Failed to process queued message:", err)
    }
  }

  /* ---- Query helpers ---- */

  private getActiveRun(conversationId: string): AgentRun | undefined {
    for (const run of this.runs.values()) {
      if (
        run.conversationId === conversationId &&
        (run.status === "running" ||
          run.status === "queued" ||
          run.status === "waiting_tool" ||
          run.status === "waiting_approval")
      ) {
        return run
      }
    }
    return undefined
  }

  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId)
  }

  /** Get the current active run ID for a conversation. */
  getCurrentRunId(conversationId: string): string | null {
    const run = this.getActiveRun(conversationId)
    return run?.id ?? null
  }

  /* ---- Internal ---- */

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}


