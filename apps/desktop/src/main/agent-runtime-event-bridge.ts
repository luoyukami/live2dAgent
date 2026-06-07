/**
 * AgentRuntimeEventBridge
 *
 * Maps AssistantRuntimeEvent → Renderer-facing AgentEvent.
 *
 * Responsibilities:
 *   1. Accumulate assistant message deltas into `message.added` on completion.
 *   2. Map run lifecycle (started/completed/failed/cancelled) to agent.idle/thinking/error.
 *   3. Map tool lifecycle (started/completed/failed) to tool.started/finished/error.
 *   4. Forward ws.ready/ws.closed as agent.idle/agent.error (best-effort).
 *   5. Do NOT leak raw model or provider payloads to the renderer.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §12.
 */
import type {
  AssistantRuntimeEvent,
  AgentEvent,
  AgentAction,
  ToolResult,
} from "@live2d-agent/agent-core"

/* ------------------------------------------------------------------ */
/*  Bridge                                                              */
/* ------------------------------------------------------------------ */

export class AgentRuntimeEventBridge {
  /**
   * Pending messages keyed by messageId.
   * Accumulates deltas from `message.delta` events and emits a single
   * `message.added` when `message.completed` fires.
   */
  private readonly pendingMessages = new Map<string, {
    conversationId: string
    runId: string
    messageId: string
    content: string
  }>()

  /**
   * Tool names keyed by toolCallId.
   * tool.started carries `name` but tool.completed/tool.failed do not,
   * so we remember the name for each callId.
   */
  private readonly toolNames = new Map<string, string>()

  /** Registered AgentEvent listeners. */
  private readonly listeners = new Set<(event: AgentEvent) => void>()

  /** Subscribe to bridged AgentEvents. Returns an unsubscribe function. */
  subscribe(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /** Clear all state and listeners (teardown). */
  clear(): void {
    this.listeners.clear()
    this.pendingMessages.clear()
    this.toolNames.clear()
  }

  /**
   * Process a single AssistantRuntimeEvent and produce zero or more
   * AgentEvent emissions.
   */
  process(event: AssistantRuntimeEvent): void {
    switch (event.type) {
      /* ---- Connection ---- */
      case "ws.ready":
        // No direct AgentEvent mapping — emit agent.idle
        this.emit({ type: "agent.idle" })
        break

      case "ws.closed":
        this.emit({ type: "agent.error", error: `Connection closed: ${event.reason}` })
        this.emit({ type: "agent.idle" })
        break

      /* ---- Run lifecycle ---- */
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

      case "run.queued":
        // No direct mapping — suppress
        break

      /* ---- Message streaming ---- */
      case "message.created":
        {
          this.pendingMessages.set(event.messageId, {
            conversationId: event.conversationId,
            runId: event.runId,
            messageId: event.messageId,
            content: "",
          })
          this.emit({
            type: "message.created",
            message: {
              id: event.messageId,
              role: "assistant",
              createdAt: Date.now(),
            },
          })
        }
        break

      case "message.delta":
        {
          const pending = this.pendingMessages.get(event.messageId)
          if (pending) {
            pending.content += event.delta
          }
          this.emit({
            type: "message.delta",
            messageId: event.messageId,
            delta: event.delta,
          })
        }
        break

      case "message.completed":
        {
          const pending = this.pendingMessages.get(event.messageId)
          if (pending) {
            this.pendingMessages.delete(event.messageId)
            this.emit({ type: "message.completed", messageId: event.messageId })
            // Backward compat: keep emitting message.added for existing UI
            this.emit({
              type: "message.added",
              message: {
                id: pending.messageId,
                role: "assistant",
                content: pending.content,
                createdAt: Date.now(),
              },
            })
          } else {
            // unknown messageId — emit completed anyway (no content to add)
            this.emit({ type: "message.completed", messageId: event.messageId })
          }
        }
        break

      /* ---- Tool execution ---- */
      case "tool.started":
        this.toolNames.set(event.toolCallId, event.name)
        this.emit({
          type: "tool.started",
          action: toolCallToAgentAction(event.toolCallId, event.name),
        })
        break

      case "tool.completed":
        {
          const name = this.toolNames.get(event.toolCallId) ?? "unknown"
          this.emit({
            type: "tool.finished",
            result: toolResultToToolResult(event.toolCallId, name, event.summary, "ok"),
          })
        }
        break

      case "tool.failed":
        {
          const name = this.toolNames.get(event.toolCallId) ?? "unknown"
          this.emit({
            type: "tool.error",
            result: toolResultToToolResult(event.toolCallId, name, event.error.message, "error"),
          })
        }
        break
    }
  }

  /* ---- Internal ---- */

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Listener errors must never break the bridge
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function toolCallToAgentAction(toolCallId: string, name: string): AgentAction {
  return {
    id: toolCallId,
    providerToolCallId: toolCallId,
    tool: name,
    args: {},
    source: "llm",
    createdAt: Date.now(),
  }
}

function toolResultToToolResult(
  toolCallId: string,
  name: string,
  summary: string,
  status: "ok" | "error",
): ToolResult {
  const now = Date.now()
  return {
    actionId: toolCallId,
    providerToolCallId: toolCallId,
    tool: name,
    ok: status === "ok",
    content: summary,
    error:
      status === "error"
        ? { code: "TOOL_ERROR", message: summary, recoverable: true }
        : undefined,
    startedAt: now,
    endedAt: now,
  }
}
