/**
 * AssistantRun — per-run state tracking for the AssistantRuntime.
 *
 * Each call to sendUserMessage creates one AssistantRun (or queues it).
 * The run tracks:
 *   - Status / lifecycle
 *   - Tool call and continuation counters
 *   - Replay counter (max 1 replay per run)
 *   - Doom loop detector instance
 *   - Accumulated assistant text delta
 *   - Remote response ID for continuation
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §10.
 */

import { DoomLoopDetector } from "../tools/doom-loop-detector.js"

/* ------------------------------------------------------------------ */
/*  Run status                                                         */
/* ------------------------------------------------------------------ */

export type AssistantRunStatus =
  | "queued"
  | "running"
  | "processing_tools"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"

/* ------------------------------------------------------------------ */
/*  AssistantRun                                                       */
/* ------------------------------------------------------------------ */

export class AssistantRun {
  readonly runId: string
  readonly conversationId: string
  readonly userMessageId: string
  status: AssistantRunStatus = "running"
  assistantMessageId: string | null = null
  assistantContent: string = ""

  /** Remote response ID from the provider, used for continuation. */
  remoteResponseId: string | null = null

  /** Tool call counter (max MAX_TOOL_CALLS_PER_RUN). */
  toolCallCount: number = 0
  /** Continuation counter (max MAX_MODEL_CONTINUATIONS_PER_RUN). */
  continuationCount: number = 0
  /** Replay counter (max 1). */
  replayCount: number = 0

  /** Doom loop detector instance for this run. */
  doomLoopDetector: DoomLoopDetector = new DoomLoopDetector()

  /** Timestamps. */
  readonly startedAt: number
  completedAt: number | null = null

  constructor(
    runId: string,
    conversationId: string,
    userMessageId: string,
  ) {
    this.runId = runId
    this.conversationId = conversationId
    this.userMessageId = userMessageId
    this.startedAt = Date.now()
  }

  /* ---- Query helpers ---- */

  get isActive(): boolean {
    return this.status === "running" || this.status === "processing_tools"
  }

  get isTerminal(): boolean {
    return (
      this.status === "completed" ||
      this.status === "cancelled" ||
      this.status === "failed"
    )
  }

  get isCancellingOrCancelled(): boolean {
    return this.status === "cancelling" || this.status === "cancelled"
  }

  /* ---- Mutations ---- */

  markToolCall(): void {
    this.toolCallCount++
  }

  markContinuation(): void {
    this.continuationCount++
  }

  markReplay(): void {
    this.replayCount++
  }

  hasReplayBudget(): boolean {
    return this.replayCount < 1
  }

  complete(): void {
    this.status = "completed"
    this.completedAt = Date.now()
  }

  fail(): void {
    this.status = "failed"
    this.completedAt = Date.now()
  }

  cancel(): void {
    this.status = "cancelled"
    this.completedAt = Date.now()
  }

  markCancelling(): void {
    this.status = "cancelling"
  }
}
