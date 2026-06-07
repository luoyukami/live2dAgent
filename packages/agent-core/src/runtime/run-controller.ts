/**
 * RunController — orchestrates a single user-message → model-response cycle.
 *
 * Phase 1: plain-text streaming support.
 * Phase 2: tool call continuation.
 *   - Collects tool calls from ModelWsEvent.response.tool_call.created
 *   - Processes them through permission check, execution, truncation
 *   - Sends results back to model and triggers continuation
 *   - Enforces MAX_TOOL_CALLS_PER_RUN (20) and MAX_MODEL_CONTINUATIONS_PER_RUN (30)
 *
 * See docs/ws_model_communication_architecture.md §3.1 (RunController), §10.
 */
import type {
  AgentRun,
  AgentRuntimeEvent,
  RuntimeErrorPayload,
  WsToolCall,
  WsToolResult,
} from "../ws/ws-types.js"
import type {
  ModelWsClient,
  ModelWsEvent,
} from "../ws/model-ws-client.js"
import type { ToolRegistry } from "../tool-registry.js"
import type { ConversationManager } from "../conversation/conversation-manager.js"
import type { WsSessionManager } from "../ws/ws-session-manager.js"
import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"
import { RuntimeErrors } from "../ws/ws-errors.js"
import { processToolCalls, type ArtifactWriter, type ToolCallProcessResult } from "../tools/tool-runtime.js"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RuntimeEventCallback = (event: AgentRuntimeEvent) => void
export type RuntimeEventUnsubscribe = () => void

/**
 * Input abstraction for tool execution that is compatible with processToolCalls.
 * The host (Electron main process) provides a real implementation; tests provide mocks.
 */
export interface ToolExecutionContext {
  executeMany(
    calls: Array<{ id: string; tool: string; args: unknown }>,
  ): Promise<Array<{ id: string; ok: boolean; content: string; data?: unknown }>>
}

/** Permission check abstraction compatible with processToolCalls. */
export interface ToolPermissionContext {
  check(
    actions: Array<{ id: string; tool: string; args: unknown }>,
  ): Promise<{ status: "approved" | "denied"; actions: Array<{ id: string; tool: string; args: unknown }>; reason?: string }>
}

/** Optional tool configuration for RunController. */
export interface RunControllerToolOpts {
  toolRegistry: ToolRegistry
  runtime: ToolExecutionContext
  permission: ToolPermissionContext
  artifactWriter?: ArtifactWriter
}

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
  private wsSessionUnsubscribe: (() => void) | null = null

  /* ---- Phase 2: tool call state ---- */

  /** Collected tool calls pending processing, keyed by run ID. */
  private pendingToolCalls = new Map<string, WsToolCall[]>()
  /** Continuation counter per run ID. */
  private continuationCount = new Map<string, number>()

  /* ---- Phase 3: replay tracking ---- */

  /** Replay count per conversation (max 1). */
  private replayCount = new Map<string, number>()
  /** Original user message text per run ID for replay. */
  private runUserText = new Map<string, string>()

  constructor(
    private conversationManager: ConversationManager,
    private wsSessionManager: WsSessionManager,
    private modelWsClient: ModelWsClient,
    private toolOpts?: RunControllerToolOpts,
  ) {
    // Subscribe to model WS events
    this.modelWsUnsubscribe = this.modelWsClient.onEvent((event) =>
      this.handleModelWsEvent(event),
    )
    // Subscribe to WS session events for reconnect failure handling
    this.wsSessionUnsubscribe = this.wsSessionManager.onEvent((event) => {
      if (event.type === "ws.error" && event.error.code === "ws_reconnect_failed") {
        this.handleReconnectFailed(event.conversationId)
      }
    })
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
   * - If an active run exists, the message is queued with a real run ID.
   * - If the queue is full, throws a RuntimeErrorPayload with code conversation_queue_full.
   */
  async enqueueUserMessage(conversationId: string, text: string): Promise<void> {
    const conv = this.conversationManager.getConversation(conversationId)
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`)
    }

    // Check if there's an active run
    const activeRun = this.getActiveRun(conversationId)
    if (activeRun) {
      // Queue the message with a real run ID
      const queue = this.getOrCreateQueue(conversationId)
      if (queue.length >= WS_RUNTIME_CONSTANTS.MAX_QUEUED_USER_MESSAGES_PER_CONVERSATION) {
        // Use RuntimeErrorPayload with conversation_queue_full code
        const error = RuntimeErrors.conversationQueueFull()
        const runId = this.generateId("run_q")
        this.emit({
          type: "run.failed",
          conversationId,
          runId,
          error,
        })
        throw error
      }

      // Create a queued run entry with traceable ID
      const now = Date.now()
      const queuedRun: AgentRun = {
        id: this.generateId("run_q"),
        conversationId,
        status: "queued",
        userMessageId: "",
        assistantMessageId: null,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        stepIndex: 0,
        toolCallCount: 0,
      }
      this.runs.set(queuedRun.id, queuedRun)
      queue.push({ content: text, conversationId })
      // Emit queued event with real run ID
      this.emit({ type: "run.queued", conversationId, runId: queuedRun.id })
      return
    }

    // No active run — start immediately
    await this.startRun(conversationId, text)
  }

  /**
   * Cancel the currently active run for a conversation.
   *
   * Flow: cancelling → cancelled
   * - Saves partial assistant message (via flushDelta)
   * - Calls modelWsClient.cancelResponse
   * - Clears active response, transitions WS back to ready
   * - Processes next queued message
   */
  async cancelRun(conversationId: string): Promise<void> {
    const run = this.getActiveRun(conversationId)
    if (!run || run.status === "cancelled" || run.status === "completed" || run.status === "failed") return

    run.status = "cancelling"
    run.updatedAt = Date.now()

    // Tell the model to cancel
    const responseId = this.wsSessionManager.getActiveResponseId(conversationId)
    if (responseId) {
      try {
        await this.modelWsClient.cancelResponse({ responseId })
      } catch {
        // Non-critical — proceed with local cancellation
      }
    }

    // Flush any pending delta (saves partial assistant message content)
    this.flushDelta()

    // Mark cancelled
    run.status = "cancelled"
    run.completedAt = Date.now()
    run.updatedAt = Date.now()

    // Clean up tool state
    this.pendingToolCalls.delete(run.id)
    this.continuationCount.delete(run.id)

    this.emit({ type: "run.cancelled", conversationId, runId: run.id })

    // Cleanup: transition WS to ready, clear active run/response, process queue
    this.cleanupAfterRun(conversationId)
  }

  /* ---- Phase 3: reconnect & replay ---- */

  /**
   * Handle reconnect failure for a conversation.
   *
   * Flow:
   *   1. If there is an active run, fail it.
   *   2. If the user message is replayable (max 1), start a new run.
   *   3. If replay already attempted, emit run_replay_failed.
   */
  private handleReconnectFailed(conversationId: string): void {
    const activeRunId = this.wsSessionManager.getActiveRunId(conversationId)
    if (!activeRunId) return

    const run = this.runs.get(activeRunId)
    if (!run) return

    const userText = this.runUserText.get(activeRunId)
    if (!userText) {
      // No user text stored — can't replay, fail with run_replay_failed
      this.failRun(run, RuntimeErrors.runReplayFailed())
      return
    }

    const replayCount = this.replayCount.get(conversationId) ?? 0
    if (replayCount >= 1) {
      // Already replayed once — fail with run_replay_failed
      this.failRun(run, RuntimeErrors.runReplayFailed())
      return
    }

    // Mark replay count
    this.replayCount.set(conversationId, replayCount + 1)

    // Fail current run (triggers cleanupAfterRun → processes queue → clears active run)
    this.failRun(run, RuntimeErrors.wsReconnectFailed())

    // Start replay run after current cleanup completes
    // Use queueMicrotask to let the current failRun/cleanupAfterRun call stack finish
    queueMicrotask(() => {
      this.startRun(conversationId, userText).catch((err) => {
        console.error("[RunController] Replay failed:", err)
      })
    })
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
    if (this.wsSessionUnsubscribe) {
      this.wsSessionUnsubscribe()
      this.wsSessionUnsubscribe = null
    }
    this.eventListeners.clear()
    this.queues.clear()
    this.runs.clear()
    this.pendingToolCalls.clear()
    this.continuationCount.clear()
    this.replayCount.clear()
    this.runUserText.clear()
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
    // Store user text for potential replay
    this.runUserText.set(run.id, text)
    // Initialize tool tracking for this run
    this.pendingToolCalls.set(run.id, [])
    this.continuationCount.set(run.id, 0)
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

      case "response.tool_call.created": {
        this.handleToolCallCreated(event)
        break
      }

      case "response.completed": {
        this.handleResponseCompleted(event)
        break
      }

      case "response.cancelled": {
        if (!this.currentRunId) break
        const run = this.runs.get(this.currentRunId)
        if (!run) break
        // Skip if already cancelled (cancelRun may have already processed this)
        if (run.status === "cancelled" || run.status === "cancelling") {
          this.cleanupAfterRun(run.conversationId)
          break
        }
        // Flush any remaining text before marking cancelled
        this.flushDelta()
        run.status = "cancelled"
        run.completedAt = Date.now()
        this.emit({
          type: "run.cancelled",
          conversationId: run.conversationId,
          runId: run.id,
        })
        this.pendingToolCalls.delete(run.id)
        this.continuationCount.delete(run.id)
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

  /* ---- Phase 2: tool call handling ---- */

  /**
   * Handle a tool call created event from the model.
   *
   * Collects tool calls for processing when the response completes.
   * Enforces MAX_TOOL_CALLS_PER_RUN limit.
   */
  private handleToolCallCreated(event: ModelWsEvent & { type: "response.tool_call.created" }): void {
    if (!this.currentRunId) return
    const run = this.runs.get(this.currentRunId)
    if (!run) return

    // Check tool call count limit
    if (run.toolCallCount >= WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN) {
      // Emit failure and skip collecting — run will be failed at response.completed
      this.emit({
        type: "tool.call.failed",
        conversationId: run.conversationId,
        runId: run.id,
        toolCallId: event.toolCall.id,
        error: {
          code: "max_tool_calls_exceeded",
          message: `Tool call limit (${WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN}) exceeded`,
          retryable: false,
        },
      })
      this.failRun(run, {
        code: "max_tool_calls_exceeded",
        message: `Tool call limit (${WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN}) exceeded`,
        retryable: false,
      })
      return
    }

    // Increment tool call count
    run.toolCallCount += 1
    run.updatedAt = Date.now()

    // Emit tool.call.created
    this.emit({
      type: "tool.call.created",
      conversationId: run.conversationId,
      runId: run.id,
      toolCall: event.toolCall,
    })

    // Collect for batch processing
    const calls = this.pendingToolCalls.get(run.id) ?? []
    calls.push(event.toolCall)
    this.pendingToolCalls.set(run.id, calls)
  }

  /**
   * Handle response completed event.
   *
   * If there are pending tool calls, process them instead of completing.
   * Otherwise, complete the run normally.
   */
  private handleResponseCompleted(event: ModelWsEvent & { type: "response.completed" }): void {
    if (!this.currentRunId) return
    const run = this.runs.get(this.currentRunId)
    if (!run) return

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

    // Check for pending tool calls
    const pending = this.pendingToolCalls.get(run.id) ?? []

    if (pending.length > 0) {
      // Don't complete the run — process tool calls first

      // Emit assistant.message.completed for the text portion (the response text is done)
      if (this.currentMessageId) {
        this.emit({
          type: "assistant.message.completed",
          conversationId: run.conversationId,
          runId: run.id,
          messageId: this.currentMessageId,
        })
      }

      // Save the current run ID so failCurrentRun can still work after clearDeltaState
      const runId = this.currentRunId

      this.clearDeltaState() // Reset delta state (new message will be created for continuation)
      this.wsSessionManager.transitionSessionState(run.conversationId, "waiting_approval")
      run.status = "waiting_approval"
      run.updatedAt = Date.now()

      // Emit waiting_approval events
      for (const call of pending) {
        this.emit({
          type: "tool.call.waiting_approval",
          conversationId: run.conversationId,
          runId: run.id,
          toolCallId: call.id,
        })
      }

      // Process the tool calls (asynchronous)
      this.processPendingToolCalls(run, runId).catch((err) => {
        console.error("[RunController] Tool processing failed:", err)
        // Ensure failCurrentRun has a valid run ID
        const prevRunId = this.currentRunId
        if (!this.currentRunId && runId) this.currentRunId = runId
        this.failCurrentRun({
          code: "tool_execution_failed",
          message: err instanceof Error ? err.message : "Tool processing failed",
          retryable: false,
          cause: err,
        })
        this.currentRunId = prevRunId
      })
    } else {
      // No tool calls — complete normally
      this.completeCurrentRun()
    }
  }

  /**
   * Process all pending tool calls for a run.
   *
   * Flow:
   *   1. Run is in waiting_approval state
   *   2. Process through processToolCalls (validate → permission → execute → truncate)
   *   3. Emit tool.call.started / completed / failed events
   *   4. Send results to the model via sendToolResult
   *   5. Check MAX_MODEL_CONTINUATIONS_PER_RUN limit
   *   6. Create continuation response via createResponse
   */
  private async processPendingToolCalls(run: AgentRun, savedRunId: string | null = null): Promise<void> {
    const pending = this.pendingToolCalls.get(run.id) ?? []
    if (pending.length === 0) {
      // No tool calls — complete the run
      run.status = "running"
      run.updatedAt = Date.now()
      this.wsSessionManager.transitionSessionState(run.conversationId, "responding")
      return
    }

    // Verify tool options are configured
    if (!this.toolOpts) {
      // Tool calls received but no tool runtime configured — emit error for each
      for (const call of pending) {
        this.emit({
          type: "tool.call.failed",
          conversationId: run.conversationId,
          runId: run.id,
          toolCallId: call.id,
          error: {
            code: "tool_execution_failed",
            message: "Tool runtime not configured",
            retryable: false,
          },
        })
      }
      // Temporarily restore currentRunId so failCurrentRun can emit the event
      const prevRunId = this.currentRunId
      this.currentRunId = savedRunId ?? run.id
      this.failCurrentRun({
        code: "tool_execution_failed",
        message: "Tool runtime not configured for RunController",
        retryable: false,
      })
      this.currentRunId = prevRunId
      return
    }

    // Transition to waiting_tool state
    this.wsSessionManager.transitionSessionState(run.conversationId, "waiting_tool")
    run.status = "waiting_tool"
    run.updatedAt = Date.now()

    // Emit tool.call.started for each pending call
    for (const call of pending) {
      this.emit({
        type: "tool.call.started",
        conversationId: run.conversationId,
        runId: run.id,
        toolCallId: call.id,
      })
    }

    // Process through the tool pipeline
    const processResults = await processToolCalls({
      toolCalls: pending,
      toolRegistry: this.toolOpts.toolRegistry,
      runtime: this.toolOpts.runtime,
      permission: this.toolOpts.permission,
      artifactWriter: this.toolOpts.artifactWriter,
    })

    // Emit completion/failure events and send results
    const responseId = this.wsSessionManager.getActiveResponseId(run.conversationId)

    for (const pr of processResults) {
      if (pr.result.status === "ok") {
        this.emit({
          type: "tool.call.completed",
          conversationId: run.conversationId,
          runId: run.id,
          toolCallId: pr.toolCallId,
          result: pr.result,
        })
      } else {
        this.emit({
          type: "tool.call.failed",
          conversationId: run.conversationId,
          runId: run.id,
          toolCallId: pr.toolCallId,
          error: {
            code: pr.result.status === "denied" ? "tool_permission_denied" : "tool_execution_failed",
            message: pr.result.summary,
            retryable: pr.result.status === "denied", // Permission denied is recoverable
          },
        })
      }

      // Send tool result back to the model
      if (responseId) {
        try {
          await this.modelWsClient.sendToolResult({
            responseId,
            toolCallId: pr.toolCallId,
            result: pr.result,
          })
        } catch (err) {
          console.error("[RunController] Failed to send tool result:", err)
        }
      }
    }

    // Clear pending tool calls for this run
    this.pendingToolCalls.set(run.id, [])

    // Check continuation limit
    const contCount = (this.continuationCount.get(run.id) ?? 0) + 1
    this.continuationCount.set(run.id, contCount)

    if (contCount > WS_RUNTIME_CONSTANTS.MAX_MODEL_CONTINUATIONS_PER_RUN) {
      this.failRun(run, {
        code: "max_model_continuations_exceeded",
        message: `Model continuation limit (${WS_RUNTIME_CONSTANTS.MAX_MODEL_CONTINUATIONS_PER_RUN}) exceeded`,
        retryable: false,
      })
      return
    }

    // Transition back to responding
    this.wsSessionManager.transitionSessionState(run.conversationId, "responding")
    run.status = "running"
    run.updatedAt = Date.now()

    // Create continuation response
    try {
      const messages = this.conversationManager.getMessages(run.conversationId)
      const modelMessages = messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))

      const remoteContextId = this.wsSessionManager.getRemoteContextId(run.conversationId)

      // Create new assistant message placeholder for the continuation
      const assistantMessage = this.conversationManager.appendAssistantMessage(run.conversationId)
      if (assistantMessage) {
        this.currentMessageId = assistantMessage.id
        this.currentRunId = run.id
        this.currentDelta = ""

        this.emit({
          type: "assistant.message.created",
          conversationId: run.conversationId,
          runId: run.id,
          messageId: assistantMessage.id,
        })
      }

      await this.modelWsClient.createResponse({
        messages: modelMessages,
        ...(remoteContextId ? { remoteContextId } : {}),
      })
    } catch (err) {
      console.error("[RunController] Continuation createResponse failed:", err)
      this.failRun(run, {
        code: "ws_protocol_error",
        message: err instanceof Error ? err.message : "Continuation createResponse failed",
        retryable: true,
        cause: err,
      })
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

    this.failRun(run, error)
  }

  private failRun(run: AgentRun, error: RuntimeErrorPayload): void {

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

    this.pendingToolCalls.delete(run.id)
    this.continuationCount.delete(run.id)

    this.cleanupAfterRun(run.conversationId)
  }

  private cleanupAfterRun(conversationId: string): void {
    this.transitionSessionToReady(conversationId)
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

  private transitionSessionToReady(conversationId: string): void {
    const state = this.wsSessionManager.getState(conversationId)
    if (!state || state === "ready" || state === "closed" || state === "disconnected") return

    try {
      if (state === "waiting_tool" || state === "waiting_approval") {
        this.wsSessionManager.transitionSessionState(conversationId, "responding")
      }
      this.wsSessionManager.transitionSessionState(conversationId, "ready")
    } catch {
      // State recovery should not hide the original run result. Phase 3
      // reconnect handling will own abnormal connection repair.
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
