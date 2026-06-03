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

    while (true) {
      this.events.emit({ type: "agent.thinking" })

      const assistantMessage = await this.model.query({
        messages: this.messages,
        tools: this.tools.getDefinitions(),
      })

      this.addMessage(assistantMessage)

      const actions = assistantMessage.actions ?? []

      /* ---- No tool calls → idle ---- */
      if (actions.length === 0) {
        this.events.emit({ type: "agent.idle" })
        break
      }

      /* ---- Permission check ---- */
      const decision = await this.approval.check(actions)

      if (decision.status === "denied") {
        this.addMessage({
          id: this.generateId("msg"),
          role: "user",
          content: `User denied actions: ${decision.reason ?? "No reason given"}`,
          createdAt: Date.now(),
          extra: { type: "approval.denied", decision },
        })
        continue
      }

      /* ---- Emit tool-started events ---- */
      for (const action of decision.actions) {
        this.events.emit({ type: "tool.started", action })
      }

      /* ---- Execute ---- */
      const results = await this.runtime.executeMany(decision.actions)

      /* ---- Emit tool-finished / tool-error events ---- */
      for (const result of results) {
        this.events.emit(
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
        this.events.emit({ type: "agent.idle" })
        break
      }
    }
  }

  /* ---- internal helpers ---- */

  private addMessage(message: AgentMessage): void {
    this.messages.push(message)
    this.trace.append({ type: "message.added", message })
    this.events.emit({ type: "message.added", message })
  }

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}
