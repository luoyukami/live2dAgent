import type {
  AgentMessage,
  AgentAction,
  ToolResult,
  AgentEvent,
} from "./types.js"
import type { ModelAdapter } from "./model-adapter.js"
import type { ToolRegistry } from "./tool-registry.js"
import { EventBus } from "./events.js"

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
  private readonly maxSteps = 20

  constructor(
    private model: ModelAdapter,
    private tools: ToolRegistry,
    private runtime: ToolRuntime,
    private approval: PermissionController,
    private trace: TraceStore,
    private events: EventBus,
  ) {}

  /**
   * Process a new user message through the full agent loop.
   * Returns when the agent reaches an idle state.
   */
  async runUserMessage(text: string): Promise<void> {
    this.addMessage({
      id: this.generateId("msg"),
      role: "user",
      content: text,
      createdAt: Date.now(),
    })

    for (let step = 1; step <= this.maxSteps; step += 1) {
      this.emit({ type: "agent.thinking" })

      const assistantMessage = await this.model.query({
        messages: this.messages,
        tools: this.tools.getDefinitions(),
      })

      this.addMessage(assistantMessage)

      const actions = assistantMessage.actions ?? []

      /* ---- No tool calls → idle ---- */
      if (actions.length === 0) {
        this.emit({ type: "agent.idle" })
        break
      }

      /* ---- Permission check ---- */
      const decision = await this.approval.check(actions)

      if (decision.status === "denied") {
        const results = actions.map((action) => this.deniedResult(action, decision.reason ?? "User denied action"))
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
      const results = this.completeResults(actions, executedResults)

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
      if (actions.some((a) => a.tool === "task.finish")) {
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

  /* ---- internal helpers ---- */

  private addMessage(message: AgentMessage): void {
    this.messages.push(message)
    this.emit({ type: "message.added", message })
  }

  private emit(event: AgentEvent): void {
    this.trace.append(event)
    this.events.emit(event)
  }

  private completeResults(actions: AgentAction[], executedResults: ToolResult[]): ToolResult[] {
    const byActionId = new Map(executedResults.map((result) => [result.actionId, result]))
    return actions.map((action) => byActionId.get(action.id) ?? this.deniedResult(action, "Action was not approved"))
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
}
