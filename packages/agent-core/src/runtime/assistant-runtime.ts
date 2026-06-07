/**
 * AssistantRuntime — canonical runtime for user-message → model-response cycles.
 *
 * Responsibilities:
 *   1. Receive user messages and queue/cancel runs per conversation.
 *   2. Build canonical model input via ContextBuilder.
 *   3. Call ProviderRuntime for model interaction.
 *   4. Consume ModelEvent streams (text deltas, tool calls, completions).
 *   5. Execute sequential tool loops (validate → execute → limit → continue).
 *   6. Handle remote_context_not_found replay (max 1).
 *   7. Enforce MAX_TOOL_CALLS_PER_RUN and MAX_MODEL_CONTINUATIONS_PER_RUN.
 *   8. Emit AssistantRuntimeEvent for the bridge layer.
 *   9. Manage run queue (1 active, 8 queued max).
 *
 * Dependencies are injected via constructor — no provider-specific
 * implementation is created here.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §10, §13.1.
 */

import type { ModelMessage } from "../model/model-message.js"
import type { ModelEvent } from "../model/model-event.js"
import type {
  CanonicalToolDefinition,
  CanonicalToolResult,
  ModelToolCall,
  ValidatedToolCall,
  InternalToolDefinition,
  ToolExecutionResult,
} from "../model/model-tool.js"
import type {
  ProviderRuntime,
  CanonicalCreateInput,
  CanonicalToolContinuationInput,
} from "../model/model-runtime.js"
import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"
import { ToolResultLimiter } from "../tools/tool-result-limiter.js"
import { buildDoomLoopErrorOutput } from "../tools/doom-loop-detector.js"
import { AssistantRun } from "./assistant-run.js"
import type { AssistantRuntimeEvent } from "./assistant-runtime-events.js"
import { AssistantRuntimeErrors } from "./runtime-errors.js"
import type { AssistantRuntimeError } from "./runtime-errors.js"

/* ------------------------------------------------------------------ */
/*  ConversationStore — minimal storage interface                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal message store interface that AssistantRuntime depends on.
 * The existing ConversationManager can be adapted by wrapping its methods.
 */
export interface ConversationStore {
  appendUserMessage(conversationId: string, text: string): { id: string }
  appendAssistantMessage(conversationId: string): { id: string } | null
  appendToolResultMessage(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    output: string,
  ): void
  updateAssistantMessage(conversationId: string, messageId: string, content: string): boolean
  setRemoteResponseId(conversationId: string, responseId: string | null): void
  getRemoteResponseId(conversationId: string): string | null
  getConversationMessages(
    conversationId: string,
  ): Array<{ id: string; role: string; content: string }>
  hasConversation(conversationId: string): boolean
}

/* ------------------------------------------------------------------ */
/*  ContextBuilder — build canonical model input                        */
/* ------------------------------------------------------------------ */

/**
 * Simplified context builder interface.
 * Transforms raw conversation state into canonical ModelMessage[] and tools.
 * Can wrap the existing ContextManager or provide its own logic.
 */
export interface ContextBuilder {
  buildCreateInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    userText: string
    messages: Array<{ id: string; role: string; content: string }>
    tools: CanonicalToolDefinition[]
    remoteResponseId?: string | null
  }): CanonicalCreateInput

  buildContinuationInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    toolResult: CanonicalToolResult
    tools: CanonicalToolDefinition[]
    previousResponseId: string | null
  }): CanonicalToolContinuationInput
}

/* ------------------------------------------------------------------ */
/*  ToolValidationResult                                               */
/* ------------------------------------------------------------------ */

export interface ToolValidationResult {
  valid: boolean
  error?: string
  definition?: InternalToolDefinition
}

/* ------------------------------------------------------------------ */
/*  ToolManager — orchestrates tool lifecycle                          */
/* ------------------------------------------------------------------ */

/**
 * ToolManager abstracts tool schema retrieval, validation, and execution.
 *
 * The host (Electron main) provides the implementation; tests provide fakes.
 */
export interface ToolManager {
  /** Return tool definitions safe to send to the model. */
  getEnabledTools(): CanonicalToolDefinition[]

  /** Validate a tool call against the internal registry. */
  validateToolCall(call: ModelToolCall): ToolValidationResult

  /** Execute a validated tool call and return the canonical result. */
  executeToolCall(call: ValidatedToolCall): Promise<CanonicalToolResult>
}

/* ------------------------------------------------------------------ */
/*  Queued message                                                     */
/* ------------------------------------------------------------------ */

interface QueuedMessage {
  conversationId: string
  runId: string
  text: string
}

/* ------------------------------------------------------------------ */
/*  AssistantRuntime                                                   */
/* ------------------------------------------------------------------ */

export class AssistantRuntime {
  /* ---- Dependencies ---- */
  private readonly provider: ProviderRuntime
  private readonly conversationStore: ConversationStore
  private readonly contextBuilder: ContextBuilder
  private readonly toolManager: ToolManager
  private readonly model: string
  private readonly systemPrompt: string

  /* ---- State ---- */
  private readonly runs = new Map<string, AssistantRun>()
  private readonly queues = new Map<string, QueuedMessage[]>()
  private readonly eventListeners = new Set<(event: AssistantRuntimeEvent) => void>()

  /**
   * Tracks which conversations have had provider.open() called.
   * Ensures open() is invoked exactly once per conversation before the
   * first create() call, enabling the provider to establish its connection.
   */
  private readonly openedConversationIds = new Set<string>()

  /* ---- Tool result limiter (shared instance) ---- */
  private readonly limiter = new ToolResultLimiter()

  constructor(options: {
    provider: ProviderRuntime
    conversationStore: ConversationStore
    contextBuilder: ContextBuilder
    toolManager: ToolManager
    model: string
    systemPrompt: string
  }) {
    this.provider = options.provider
    this.conversationStore = options.conversationStore
    this.contextBuilder = options.contextBuilder
    this.toolManager = options.toolManager
    this.model = options.model
    this.systemPrompt = options.systemPrompt
  }

  /* ---- Event bus ---- */

  onEvent(callback: (event: AssistantRuntimeEvent) => void): () => void {
    this.eventListeners.add(callback)
    return () => {
      this.eventListeners.delete(callback)
    }
  }

  private emit(event: AssistantRuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // Listener errors should never break the runtime
      }
    }
  }

  /* ---- Public API ---- */

  /**
   * Send a user message for processing.
   *
   * If there is an active (non-terminal) run for the conversation, the message
   * is queued. If the queue is full, an error is thrown.
   * Returns the run ID.
   */
  async sendUserMessage(conversationId: string, text: string): Promise<string> {
    if (!this.conversationStore.hasConversation(conversationId)) {
      throw AssistantRuntimeErrors.conversationNotFound(conversationId)
    }

    // Check for active run
    const activeRun = this.getActiveRun(conversationId)
    if (activeRun) {
      return this.enqueueMessage(conversationId, text)
    }

    // Start immediately
    return this.startRun(conversationId, text)
  }

  /**
   * Cancel the currently active run for a conversation.
   */
  async cancelCurrentRun(conversationId: string): Promise<void> {
    const activeRun = this.getActiveRun(conversationId)
    if (!activeRun || activeRun.isCancellingOrCancelled) return

    activeRun.markCancelling()

    // Ask provider to cancel
    try {
      await this.provider.cancel({
        runId: activeRun.runId,
        responseId: activeRun.remoteResponseId ?? undefined,
      })
    } catch {
      // Non-critical — proceed with local cancellation
    }

    activeRun.cancel()

    // Flush any remaining delta
    if (activeRun.assistantMessageId && activeRun.assistantContent.length > 0) {
      this.conversationStore.updateAssistantMessage(
        conversationId,
        activeRun.assistantMessageId,
        activeRun.assistantContent,
      )
    }

    this.emit({
      type: "run.cancelled",
      conversationId,
      runId: activeRun.runId,
    })

    // Process queue
    this.processNextInQueue(conversationId)
  }

  /* ---- Queue management ---- */

  private enqueueMessage(conversationId: string, text: string): string {
    const queue = this.getOrCreateQueue(conversationId)

    if (queue.length >= WS_RUNTIME_CONSTANTS.MAX_QUEUED_USER_MESSAGES_PER_CONVERSATION) {
      throw AssistantRuntimeErrors.conversationQueueFull()
    }

    const runId = this.generateId("run_q")
    const run = new AssistantRun(runId, conversationId, "")
    run.status = "queued"
    this.runs.set(runId, run)

    queue.push({ conversationId, runId, text })

    this.emit({ type: "run.queued", conversationId, runId })

    return runId
  }

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

    // Clean up the queued run placeholder
    this.runs.delete(next.runId)

    if (queue.length === 0) {
      this.queues.delete(conversationId)
    }

    try {
      await this.startRun(conversationId, next.text)
    } catch {
      // Queue processing errors are logged but don't propagate
    }
  }

  /* ---- Run lifecycle ---- */

  /**
   * Start a new run: append user message, create run state, call provider,
   * consume events.
   */
  private async startRun(conversationId: string, text: string): Promise<string> {
    // 0. Ensure provider is opened for this conversation (once per conversation)
    if (!this.openedConversationIds.has(conversationId)) {
      try {
        await this.provider.open(conversationId)
        this.openedConversationIds.add(conversationId)
        this.emit({ type: "ws.ready", conversationId })
      } catch (err) {
        const error = AssistantRuntimeErrors.providerError(
          err instanceof Error ? err.message : "Failed to open provider connection",
          true,
        )
        // Create a minimal run to fail
        const runId = this.generateId("run")
        const run = new AssistantRun(runId, conversationId, "")
        this.runs.set(runId, run)
        this.emit({ type: "run.started", conversationId, runId })
        this.failRun(run, error)
        return runId
      }
    }

    // 1. Append user message
    const userMessage = this.conversationStore.appendUserMessage(conversationId, text)
    const runId = this.generateId("run")

    // 2. Create run
    const run = new AssistantRun(runId, conversationId, userMessage.id)
    this.runs.set(runId, run)

    this.emit({ type: "run.started", conversationId, runId })

    // 3. Create assistant message placeholder
    const assistantMessage = this.conversationStore.appendAssistantMessage(conversationId)
    if (!assistantMessage) {
      run.fail()
      const error = AssistantRuntimeErrors.internalError("Failed to create assistant message")
      this.emit({ type: "run.failed", conversationId, runId, error })
      return runId
    }

    run.assistantMessageId = assistantMessage.id

    this.emit({
      type: "message.created",
      conversationId,
      runId,
      messageId: assistantMessage.id,
    })

    // 4. Execute the core response consumption loop
    try {
      const remoteResponseId = this.conversationStore.getRemoteResponseId(conversationId)
      const createInput = this.contextBuilder.buildCreateInput({
        conversationId,
        runId,
        systemPrompt: this.systemPrompt,
        userText: text,
        messages: this.conversationStore.getConversationMessages(conversationId),
        tools: this.toolManager.getEnabledTools(),
        remoteResponseId,
      })

      await this.consumeResponseStream(run, createInput)
    } catch (err) {
      if (run.isTerminal) return runId // Already handled

      const error = AssistantRuntimeErrors.providerError(
        err instanceof Error ? err.message : "Unknown error",
        true,
      )
      this.failRun(run, error)
    }

    return runId
  }

  /**
   * Consume a ModelEvent stream from either a create() or continueWithToolResult() call.
   *
   * This is the core event loop that handles:
   *   - text deltas → message.delta events
   *   - tool calls → collection and processing
   *   - response completed → either complete run or process tools
   *   - response failed → remote_context_not_found replay
   *   - cancellation
   */
  /**
   * @param run - The assistant run
   * @param input - The canonical input for the provider
   * @param isContinuationStream - Whether this is a continuation stream.
   *   When true, response.completed without tool calls does NOT mark the run
   *   as complete (the outer tool loop handles completion).
   */
  private async consumeResponseStream(
    run: AssistantRun,
    input: CanonicalCreateInput | CanonicalToolContinuationInput,
    isContinuationStream: boolean = false,
  ): Promise<void> {
    const isContinuation = "toolResult" in input
    const stream = isContinuation
      ? this.provider.continueWithToolResult(input as CanonicalToolContinuationInput)
      : this.provider.create(input as CanonicalCreateInput)

    const pendingToolCalls: ModelToolCall[] = []

    for await (const event of stream) {
      if (run.isCancellingOrCancelled) break

      switch (event.type) {
        case "response.created": {
          run.remoteResponseId = event.responseId
          break
        }

        case "text.delta": {
          run.assistantContent += event.delta

          // Flush to store and emit
          if (run.assistantMessageId) {
            this.conversationStore.updateAssistantMessage(
              run.conversationId,
              run.assistantMessageId,
              run.assistantContent,
            )
          }

          this.emit({
            type: "message.delta",
            conversationId: run.conversationId,
            runId: run.runId,
            messageId: run.assistantMessageId ?? "",
            delta: event.delta,
          })
          break
        }

        case "tool.call": {
          // Per §9.8: parallelToolCalls=false — only accept the first tool call.
          // Subsequent tool calls in the same response are dropped with a warning.
          if (pendingToolCalls.length > 0) {
            console.warn(
              `[AssistantRuntime] Dropping extra tool.call "${event.name}" (${event.callId}) — only sequential tool calls supported`,
            )
            break
          }

          let args: Record<string, unknown>
          try {
            args = JSON.parse(event.argumentsText) as Record<string, unknown>
          } catch {
            // Invalid JSON arguments — still collect with empty args
            args = {}
          }

          pendingToolCalls.push({
            callId: event.callId,
            name: event.name,
            arguments: args,
          })
          break
        }

        case "response.completed": {
          // Save remote response ID for future continuations
          if (run.remoteResponseId) {
            this.conversationStore.setRemoteResponseId(
              run.conversationId,
              run.remoteResponseId,
            )
          }

          // Emit message.completed for the text portion
          if (run.assistantMessageId) {
            this.emit({
              type: "message.completed",
              conversationId: run.conversationId,
              runId: run.runId,
              messageId: run.assistantMessageId,
            })
          }

          if (pendingToolCalls.length > 0) {
            // Process tool calls sequentially
            run.status = "processing_tools"
            await this.processToolCallsSequentially(run, pendingToolCalls.splice(0))
          } else if (!isContinuationStream) {
            // No tool calls and this is the initial stream — run completed
            run.complete()
            this.emit({
              type: "run.completed",
              conversationId: run.conversationId,
              runId: run.runId,
            })
            this.cleanupAfterRun(run.conversationId)
          }
          // For continuation streams without tool calls, just return silently
          return
        }

        case "response.failed": {
          const errorCode = event.error.code
          const isRemoteContextNotFound =
            errorCode === "remote_context_not_found" ||
            errorCode === "previous_response_not_found" ||
            errorCode === "response_not_found"

          if (isRemoteContextNotFound && run.hasReplayBudget()) {
            // Replay once: clear remoteResponseId and retry with full context
            run.markReplay()
            this.conversationStore.setRemoteResponseId(run.conversationId, null)
            run.remoteResponseId = null

            // Rebuild input without remoteResponseId for full context
            const replayInput = this.contextBuilder.buildCreateInput({
              conversationId: run.conversationId,
              runId: run.runId,
              systemPrompt: this.systemPrompt,
              userText: "", // Already in conversation history
              messages: this.conversationStore.getConversationMessages(run.conversationId),
              tools: this.toolManager.getEnabledTools(),
              remoteResponseId: null,
            })

            await this.consumeResponseStream(run, replayInput)
          } else {
            // Non-retryable error or replay budget exhausted
            const error = AssistantRuntimeErrors.providerError(
              event.error.message,
              event.error.retryable,
            )
            this.failRun(run, error)
          }
          return
        }

        case "response.cancelled": {
          run.cancel()
          if (run.assistantMessageId && run.assistantContent.length > 0) {
            this.conversationStore.updateAssistantMessage(
              run.conversationId,
              run.assistantMessageId,
              run.assistantContent,
            )
          }
          this.emit({
            type: "run.cancelled",
            conversationId: run.conversationId,
            runId: run.runId,
          })
          this.cleanupAfterRun(run.conversationId)
          return
        }
      }
    }

    // Stream ended without completion event (unexpected)
    if (!run.isTerminal) {
      this.failRun(
        run,
        AssistantRuntimeErrors.internalError("Model stream ended without completion"),
      )
    }
  }

  /* ---- Sequential tool call processing ---- */

  /**
   * Process collected tool calls one at a time.
   *
   * For each tool call:
   *   1. Validate against ToolManager
   *   2. Check doom loop detector
   *   3. Emit tool.started
   *   4. Execute via ToolManager
   *   5. Limit output via ToolResultLimiter
   *   6. Emit tool.completed / tool.failed
   *   7. Append tool result to conversation store
   *   8. Continue with tool result via provider
   *   9. Consume the continuation's event stream
   */
  /**
   * Process collected tool calls sequentially. For each tool call:
   *   - Validate, check doom loop, execute, limit, continue.
   *   - Each continuation may produce more tool calls (recursive).
   *
   * After ALL tool calls are processed, if the run is still active,
   * it is marked as completed (since the model consumed all results
   * and produced final text).
   */
  private async processToolCallsSequentially(
    run: AssistantRun,
    toolCalls: ModelToolCall[],
  ): Promise<void> {
    for (const call of toolCalls) {
      if (run.isCancellingOrCancelled) break

      // Check tool call limit before each execution
      if (run.toolCallCount >= WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN) {
        this.failRun(
          run,
          AssistantRuntimeErrors.maxToolCallsExceeded(
            WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN,
          ),
        )
        return
      }

      // Check continuation limit before each continuation
      if (run.continuationCount >= WS_RUNTIME_CONSTANTS.MAX_MODEL_CONTINUATIONS_PER_RUN) {
        this.failRun(
          run,
          AssistantRuntimeErrors.maxModelContinuationsExceeded(
            WS_RUNTIME_CONSTANTS.MAX_MODEL_CONTINUATIONS_PER_RUN,
          ),
        )
        return
      }

      // --- Validate ---
      const validation = this.toolManager.validateToolCall(call)
      if (!validation.valid) {
        const error = AssistantRuntimeErrors.toolValidationFailed(
          validation.error ?? "Unknown validation error",
        )
        this.emit({
          type: "tool.failed",
          conversationId: run.conversationId,
          runId: run.runId,
          toolCallId: call.callId,
          error,
        })

        // Send error result to model so it can recover
        const errorResult: CanonicalToolResult = {
          callId: call.callId,
          name: call.name,
          status: "error",
          output: JSON.stringify({
            status: "error",
            summary: validation.error ?? "Invalid arguments",
            content: validation.error ?? "Tool call validation failed",
          }),
          summary: validation.error ?? "Tool call validation failed",
        }
        run.markToolCall()

        const cont = await this.continueWithToolResult(run, errorResult)
        if (!cont) return
        continue
      }

      // --- Doom loop check ---
      const doomResult = run.doomLoopDetector.check(call.name, call.arguments)
      if (!doomResult.allowed) {
        const errorOutput = buildDoomLoopErrorOutput(call.name, doomResult.reason!)
        const blockedResult: CanonicalToolResult = {
          callId: call.callId,
          name: call.name,
          status: "error",
          output: errorOutput,
          summary: "Repeated identical tool call blocked.",
        }

        this.emit({
          type: "tool.failed",
          conversationId: run.conversationId,
          runId: run.runId,
          toolCallId: call.callId,
          error: AssistantRuntimeErrors.toolDoomLoopBlocked(call.name),
        })

        run.markToolCall()

        const cont = await this.continueWithToolResult(run, blockedResult)
        if (!cont) return
        continue
      }

      // --- Emit tool.started ---
      this.emit({
        type: "tool.started",
        conversationId: run.conversationId,
        runId: run.runId,
        toolCallId: call.callId,
        name: call.name,
      })

      // --- Execute ---
      let result: CanonicalToolResult
      try {
        const validatedCall: ValidatedToolCall = {
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        }
        result = await this.toolManager.executeToolCall(validatedCall)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Tool execution failed"
        result = {
          callId: call.callId,
          name: call.name,
          status: "error",
          output: errorMsg,
          summary: errorMsg,
        }
      }

      run.markToolCall()

      // --- Limit tool output ---
      const limited = await this.limiter.limit(
        call.name,
        result.output,
        result.status,
      )

      const limitedResult: CanonicalToolResult = {
        ...result,
        output: limited.output,
        artifactRef: limited.artifactRef,
      }

      // --- Emit tool.completed / tool.failed ---
      if (result.status === "ok") {
        this.emit({
          type: "tool.completed",
          conversationId: run.conversationId,
          runId: run.runId,
          toolCallId: call.callId,
          summary: result.summary,
        })
      } else {
        this.emit({
          type: "tool.failed",
          conversationId: run.conversationId,
          runId: run.runId,
          toolCallId: call.callId,
          error: AssistantRuntimeErrors.toolExecutionFailed(result.summary),
        })
      }

      // --- Append tool result to conversation store ---
      this.conversationStore.appendToolResultMessage(
        run.conversationId,
        call.callId,
        call.name,
        limitedResult.output,
      )

      // --- Continue with tool result ---
      const cont = await this.continueWithToolResult(run, limitedResult)
      if (!cont) return
    }

    // All tool calls processed. If the run is still active, it means the
    // model consumed the last tool result and produced text. Complete.
    if (run.isActive) {
      run.complete()
      this.emit({
        type: "run.completed",
        conversationId: run.conversationId,
        runId: run.runId,
      })
      this.cleanupAfterRun(run.conversationId)
    }
  }

  /**
   * Send a single tool result back to the provider for continuation.
   * Returns true if the run is still active after continuation, false if terminated.
   */
  private async continueWithToolResult(
    run: AssistantRun,
    toolResult: CanonicalToolResult,
  ): Promise<boolean> {
    if (run.isCancellingOrCancelled) return false

    run.markContinuation()

    // Build continuation input
    const tools = this.toolManager.getEnabledTools()
    const continuationInput = this.contextBuilder.buildContinuationInput({
      conversationId: run.conversationId,
      runId: run.runId,
      systemPrompt: this.systemPrompt,
      toolResult,
      tools,
      previousResponseId: run.remoteResponseId,
    })

    // Create a new assistant message placeholder for the continuation text
    const assistantMessage = this.conversationStore.appendAssistantMessage(run.conversationId)
    if (assistantMessage) {
      run.assistantMessageId = assistantMessage.id
      run.assistantContent = ""

      this.emit({
        type: "message.created",
        conversationId: run.conversationId,
        runId: run.runId,
        messageId: assistantMessage.id,
      })
    }

    // Consume the continuation stream (isContinuationStream = true)
    await this.consumeResponseStream(run, continuationInput, true)

    return !run.isTerminal
  }

  /* ---- Run teardown ---- */

  private failRun(run: AssistantRun, error: AssistantRuntimeError): void {
    run.fail()
    this.emit({
      type: "run.failed",
      conversationId: run.conversationId,
      runId: run.runId,
      error,
    })
    this.cleanupAfterRun(run.conversationId)
  }

  private cleanupAfterRun(conversationId: string): void {
    this.processNextInQueue(conversationId)
  }

  /* ---- Query helpers ---- */

  /**
   * Get the active (non-terminal, non-queued) run for a conversation.
   */
  private getActiveRun(conversationId: string): AssistantRun | undefined {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId && run.isActive) {
        return run
      }
    }
    return undefined
  }

  /**
   * Get the current active run ID for a conversation.
   */
  getCurrentRunId(conversationId: string): string | null {
    const run = this.getActiveRun(conversationId)
    return run?.runId ?? null
  }

  /**
   * Get a run by ID.
   */
  getRun(runId: string): AssistantRun | undefined {
    return this.runs.get(runId)
  }

  /* ---- Internal ---- */

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}
