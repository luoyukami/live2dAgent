/**
 * RunController — orchestrates a single user-message → model-response cycle.
 *
 * Phase 1: plain-text streaming support.
 * Phase 2: tool call continuation.
 *   - Collects tool calls from ModelWsEvent.response.tool_call.created
 *   - Processes them through permission check, execution, truncation
 *   - Sends results back to model and triggers continuation
 *   - Enforces MAX_TOOL_CALLS_PER_RUN (12) and MAX_MODEL_CONTINUATIONS_PER_RUN (16)
 *
 * Key design decisions:
 *   - Delta accumulation is per-conversation (not global) — different conversations'
 *     text deltas, tool calls, and completions never intermix.
 *   - State machine transitions happen before createResponse (ready → responding)
 *     so tools can correctly transition responding → waiting_approval.
 *   - Queue items carry their runId; getActiveRun excludes "queued" status.
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
  ModelWsEvent,
} from "../ws/model-ws-client.js"
import type { ToolRegistry } from "../tool-registry.js"
import type { ConversationManager } from "../conversation/conversation-manager.js"
import type { WsSessionManager, ModelEventCallback, ModelEventUnsubscribe } from "../ws/ws-session-manager.js"
import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"
import { RuntimeErrors } from "../ws/ws-errors.js"
import { processToolCalls, type ArtifactWriter, type ToolCallProcessResult } from "../tools/tool-runtime.js"
import { ContextManager } from "../context/context-manager.js"
import type { ContextManagerInput } from "../context/context-types.js"

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
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

interface QueuedMessage {
  content: string
  conversationId: string
  /** The placeholder run ID assigned when the message was queued. */
  runId: string
}

/**
 * Per-conversation delta accumulation state.
 * Replaces the old global `currentRunId` / `currentMessageId` / `currentDelta`.
 */
interface ConversationDeltaState {
  runId: string
  messageId: string
  delta: string
  flushTimer: ReturnType<typeof setTimeout> | null
}

/* ------------------------------------------------------------------ */
/*  RunController                                                      */
/* ------------------------------------------------------------------ */

export class RunController {
  private runs = new Map<string, AgentRun>()
  private queues = new Map<string, QueuedMessage[]>()
  private eventListeners = new Set<RuntimeEventCallback>()

  /** Per-conversation delta accumulation state. */
  private deltaStates = new Map<string, ConversationDeltaState>()

  private modelEventUnsubscribe: ModelEventUnsubscribe | null = null
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

  /** System instructions for the ContextManager. */
  private systemInstructions: string = ""

  constructor(
    private conversationManager: ConversationManager,
    private wsSessionManager: WsSessionManager,
    private toolOpts?: RunControllerToolOpts,
    private contextManager: ContextManager = new ContextManager(),
  ) {
    // Subscribe to per-conversation model WS events forwarded by WsSessionManager.
    // Each event carries the conversationId so we can route to the correct delta state.
    this.modelEventUnsubscribe = this.wsSessionManager.onModelEvent(
      (conversationId: string, event: ModelWsEvent) =>
        this.handleModelWsEvent(conversationId, event),
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

  /**
   * Set system instructions for the ContextManager.
   * Called during session init when instructions are available.
   */
  setSystemInstructions(instructions: string): void {
    this.systemInstructions = instructions
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

    // Check if there's an active run (queued runs don't count as "active")
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
      queue.push({ content: text, conversationId, runId: queuedRun.id })
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
   * - Calls the per-session client's cancelResponse
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
      const client = this.wsSessionManager.getClient(conversationId)
      if (client) {
        try {
          await client.cancelResponse({ responseId })
        } catch {
          // Non-critical — proceed with local cancellation
        }
      }
    }

    // Flush any pending delta (saves partial assistant message content)
    this.flushDelta(conversationId)

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
    // Clear all per-conversation delta flush timers
    for (const convId of this.deltaStates.keys()) {
      const ds = this.deltaStates.get(convId)
      if (ds?.flushTimer) {
        clearTimeout(ds.flushTimer)
      }
    }
    this.deltaStates.clear()

    if (this.modelEventUnsubscribe) {
      this.modelEventUnsubscribe()
      this.modelEventUnsubscribe = null
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
  }

  /* ---- Run execution ---- */

  /**
   * Start a new run immediately.
   *
   * Flow:
   *   1. Append user message to conversation
   *   2. Create AgentRun record
   *   3. Ensure WS session is ready
   *   4. Transition WS session to "responding" (fixes state machine for tool calls)
   *   5. Create assistant message placeholder
   *   6. Call the per-session client's createResponse with current messages
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

    // 4. Transition to "responding" before createResponse.
    //    This fixes the state machine: createResponse leads to response.created,
    //    which is handled while in "responding". Without this, the session stays
    //    "ready" and subsequent tool call transitions (ready → waiting_approval)
    //    would throw "Invalid transition".
    this.wsSessionManager.transitionSessionState(conversationId, "responding")

    // 5. Create assistant message placeholder
    const assistantMessage = this.conversationManager.appendAssistantMessage(conversationId)
    if (!assistantMessage) {
      run.status = "failed"
      run.completedAt = Date.now()
      this.wsSessionManager.transitionSessionState(conversationId, "ready")
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

    // Setup per-conversation delta accumulation state
    this.deltaStates.set(conversationId, {
      runId: run.id,
      messageId: assistantMessage.id,
      delta: "",
      flushTimer: null,
    })

    this.emit({
      type: "assistant.message.created",
      conversationId,
      runId: run.id,
      messageId: assistantMessage.id,
    })

    // 6. Build messages using ContextManager
    const effectiveContextManager = this.contextManager
    const convMsgs = this.conversationManager.getMessages(conversationId)
    // Exclude the current user message and assistant placeholder; the current
    // user input is passed separately as currentUserMessage.
    const contextInput: ContextManagerInput = {
      systemInstructions: this.systemInstructions,
      currentUserMessage: text,
      conversationMessages: convMsgs.length > 1 ? convMsgs.slice(0, -2) : [],
      toolResults: [],
      currentArtifacts: [],
      historicalArtifacts: [],
      toolSchemas: this.toolOpts?.toolRegistry.getDefinitions() ?? [],
      currentTurnIndex: convMsgs.length,
    }
    const modelInput = effectiveContextManager.build(contextInput)

    // If the hard limit is exceeded, fail the run
    if (modelInput.error) {
      this.failRun(run, modelInput.error)
      return
    }

    // Include remote context if available
    const remoteContextId = this.wsSessionManager.getRemoteContextId(conversationId)

    // Filter tool-role messages — WS protocol uses sendToolResult API,
    // not tool-role messages embedded in createResponse.
    const createResponseMessages = modelInput.messages.filter(
      (m): m is { role: "system" | "user" | "assistant"; content: string } => m.role !== "tool",
    )

    // Call createResponse on the per-conversation client
    const client = this.wsSessionManager.getClient(conversationId)
    if (!client) {
      this.failRun(run, {
        code: "create_response_failed",
        message: "No WS client available for conversation",
        retryable: false,
      })
      return
    }

    try {
      await client.createResponse({
        messages: createResponseMessages,
        tools: this.toolOpts?.toolRegistry.getDefinitions(),
        ...(remoteContextId ? { remoteContextId } : {}),
      })
    } catch (err) {
      this.failRun(run, {
        code: "create_response_failed",
        message: err instanceof Error ? err.message : "Unknown error",
        retryable: true,
        cause: err,
      })
    }
  }

  /* ---- ModelWsEvent handler ---- */

  /**
   * Handle a model WS event for a specific conversation.
   *
   * The conversationId is provided by the WsSessionManager's per-client handler,
   * so no global responseId→conversationId mapping is needed.
   */
  private handleModelWsEvent(conversationId: string, event: ModelWsEvent): void {
    switch (event.type) {
      case "response.created": {
        this.wsSessionManager.setActiveResponse(conversationId, event.responseId)
        if (event.remoteContextId) {
          this.wsSessionManager.setRemoteContextId(conversationId, event.remoteContextId)
        }
        break
      }

      case "response.text.delta": {
        const ds = this.deltaStates.get(conversationId)
        if (!ds) break

        ds.delta += event.delta

        // Start flush timer if not already running
        if (!ds.flushTimer) {
          ds.flushTimer = setTimeout(
            () => this.flushDelta(conversationId),
            WS_RUNTIME_CONSTANTS.ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
          )
        }

        // Immediate flush if accumulated text is large
        if (ds.delta.length >= 512) {
          this.flushDelta(conversationId)
        }
        break
      }

      case "response.tool_call.created": {
        const run = this.getActiveRun(conversationId)
        if (!run) break
        this.handleToolCallCreated(run, event)
        break
      }

      case "response.completed": {
        const run = this.getActiveRun(conversationId)
        if (!run) break
        this.handleResponseCompleted(run, event)
        break
      }

      case "response.cancelled": {
        const run = this.getActiveRun(conversationId)
        if (!run) break
        // Skip if already cancelled (cancelRun may have already processed this)
        if (run.status === "cancelled" || run.status === "cancelling") {
          this.cleanupAfterRun(conversationId)
          break
        }
        // Flush any remaining text before marking cancelled
        this.flushDelta(conversationId)
        run.status = "cancelled"
        run.completedAt = Date.now()
        this.emit({
          type: "run.cancelled",
          conversationId: run.conversationId,
          runId: run.id,
        })
        this.pendingToolCalls.delete(run.id)
        this.continuationCount.delete(run.id)
        this.cleanupAfterRun(conversationId)
        break
      }

      case "error": {
        const run = this.getActiveRun(conversationId)
        if (!run) break
        this.failRun(run, event.error)
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
  private handleToolCallCreated(run: AgentRun, event: ModelWsEvent & { type: "response.tool_call.created" }): void {
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
  private handleResponseCompleted(run: AgentRun, event: ModelWsEvent & { type: "response.completed" }): void {
    // Flush remaining delta
    this.flushDelta(run.conversationId)

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
      const ds = this.deltaStates.get(run.conversationId)
      if (ds?.messageId) {
        this.emit({
          type: "assistant.message.completed",
          conversationId: run.conversationId,
          runId: run.id,
          messageId: ds.messageId,
        })
      }

      // Save the run's conversation ID for tool processing closure
      const savedConversationId = run.conversationId

      this.clearDeltaState(run.conversationId) // Reset delta state (new message will be created for continuation)
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
      this.processPendingToolCalls(run, savedConversationId).catch((err) => {
        console.error("[RunController] Tool processing failed:", err)
        // Ensure failRun has a valid run
        this.failRun(run, {
          code: "tool_execution_failed",
          message: err instanceof Error ? err.message : "Tool processing failed",
          retryable: false,
          cause: err,
        })
      })
    } else {
      // No tool calls — complete normally
      this.completeCurrentRun(run)
    }
  }

  /**
   * Process all pending tool calls for a run.
   *
   * Flow:
   *   1. Run is in waiting_approval state
   *   2. Process through processToolCalls (validate → permission → execute → truncate)
   *   3. Emit tool.call.started / completed / failed events
   *   4. Send results to the model via the per-session client's sendToolResult
   *   5. Check MAX_MODEL_CONTINUATIONS_PER_RUN limit
   *   6. Create continuation response via the per-session client's createResponse
   */
  private async processPendingToolCalls(run: AgentRun, savedConversationId: string): Promise<void> {
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
      this.failRun(run, {
        code: "tool_execution_failed",
        message: "Tool runtime not configured for RunController",
        retryable: false,
      })
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

    // Build tool name lookup for continuation mapping
    const toolNameByCallId = new Map(pending.map((tc) => [tc.id, tc.name]))

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
    const client = this.wsSessionManager.getClient(run.conversationId)

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
      if (responseId && client) {
        try {
          await client.sendToolResult({
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
      const effectiveContextManager = this.contextManager
      const convMsgs = this.conversationManager.getMessages(run.conversationId)
      const contextInput: ContextManagerInput = {
        systemInstructions: this.systemInstructions,
        currentUserMessage: "", // No new user input on continuation
        conversationMessages: convMsgs,
        toolResults: processResults.map((pr) => ({
          toolCallId: pr.toolCallId,
          toolName: toolNameByCallId.get(pr.toolCallId) ?? "unknown",
          status: pr.result.status,
          summary: pr.result.summary,
          contentForModel: pr.result.contentForModel,
          artifactRef: pr.result.artifactRef,
        })),
        currentArtifacts: [],
        historicalArtifacts: [],
        toolSchemas: this.toolOpts?.toolRegistry.getDefinitions() ?? [],
        currentTurnIndex: convMsgs.length,
      }
      const modelInput = effectiveContextManager.build(contextInput)

      // If hard limit exceeded, fail
      if (modelInput.error) {
        this.failRun(run, modelInput.error)
        return
      }

      // Filter out tool-role messages for WS protocol
      const createResponseMessages = modelInput.messages.filter(
        (m): m is { role: "system" | "user" | "assistant"; content: string } => m.role !== "tool",
      )

      const remoteContextId = this.wsSessionManager.getRemoteContextId(run.conversationId)

      // Create new assistant message placeholder for the continuation
      const assistantMessage = this.conversationManager.appendAssistantMessage(run.conversationId)
      if (assistantMessage) {
        this.deltaStates.set(run.conversationId, {
          runId: run.id,
          messageId: assistantMessage.id,
          delta: "",
          flushTimer: null,
        })

        this.emit({
          type: "assistant.message.created",
          conversationId: run.conversationId,
          runId: run.id,
          messageId: assistantMessage.id,
        })
      }

      const continuationClient = this.wsSessionManager.getClient(run.conversationId)
      if (continuationClient) {
        await continuationClient.createResponse({
          messages: createResponseMessages,
          tools: this.toolOpts?.toolRegistry.getDefinitions(),
          ...(remoteContextId ? { remoteContextId } : {}),
        })
      } else {
        this.failRun(run, {
          code: "ws_protocol_error",
          message: "No WS client available for continuation",
          retryable: true,
        })
      }
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

  /**
   * Flush accumulated delta for a specific conversation.
   */
  private flushDelta(conversationId: string): void {
    const ds = this.deltaStates.get(conversationId)
    if (!ds) return

    if (ds.flushTimer) {
      clearTimeout(ds.flushTimer)
      ds.flushTimer = null
    }

    if (ds.delta.length === 0) return

    const run = this.runs.get(ds.runId)
    if (!run) return

    const text = ds.delta
    ds.delta = ""

    // Append to the conversation message
    this.conversationManager.updateAssistantMessage(
      run.conversationId,
      ds.messageId,
      this.getCurrentAssistantContent(run.conversationId, ds.messageId) + text,
    )

    this.emit({
      type: "assistant.message.delta",
      conversationId: run.conversationId,
      runId: run.id,
      messageId: ds.messageId,
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

  private completeCurrentRun(run: AgentRun): void {
    run.status = "completed"
    run.completedAt = Date.now()
    run.updatedAt = Date.now()

    if (run.toolCallCount > 0) {
      this.conversationManager.setLastRemoteContextId(run.conversationId, null)
      this.wsSessionManager.setRemoteContextId(run.conversationId, null)
    }

    const ds = this.deltaStates.get(run.conversationId)

    this.emit({
      type: "assistant.message.completed",
      conversationId: run.conversationId,
      runId: run.id,
      messageId: ds?.messageId ?? "",
    })

    this.emit({
      type: "run.completed",
      conversationId: run.conversationId,
      runId: run.id,
    })

    this.cleanupAfterRun(run.conversationId)
  }

  private failRun(run: AgentRun, error: RuntimeErrorPayload): void {
    // Flush any remaining delta before failing
    this.flushDelta(run.conversationId)

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
    this.clearDeltaState(conversationId)
    this.wsSessionManager.clearActiveRun(conversationId)
    this.wsSessionManager.clearActiveResponse(conversationId)

    // Process next queued message
    this.processNextInQueue(conversationId)
  }

  private clearDeltaState(conversationId: string): void {
    const ds = this.deltaStates.get(conversationId)
    if (ds) {
      if (ds.flushTimer) {
        clearTimeout(ds.flushTimer)
      }
      this.deltaStates.delete(conversationId)
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

    // Remove the stale queued run placeholder — it was just a marker
    // and should not pollute getActiveRun or future queries.
    this.runs.delete(next.runId)

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

  /**
   * Get the active (non-queued, non-terminal) run for a conversation.
   * "queued" runs are explicitly excluded so they don't block new messages
   * or pollute the active-run workflow.
   */
  private getActiveRun(conversationId: string): AgentRun | undefined {
    for (const run of this.runs.values()) {
      if (
        run.conversationId === conversationId &&
        (run.status === "running" ||
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
