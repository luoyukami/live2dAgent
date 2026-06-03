import type { AgentEvent, AgentEventCallback, Unsubscribe } from "./types.js"

/**
 * Simple typed event bus.
 *
 * Design notes:
 * - Synchronous dispatch — events are emitted in the same tick.
 * - Errors in one listener do not affect others (caught and logged).
 * - No Node / Electron dependency — works in any JS runtime.
 */
export class EventBus {
  private listeners = new Set<AgentEventCallback>()

  /** Register a callback that receives every event. Returns an unsubscribe function. */
  subscribe(callback: AgentEventCallback): Unsubscribe {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /** Emit an event to all registered listeners. */
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("[EventBus] listener error:", err)
      }
    }
  }

  /** Remove all listeners (useful for teardown). */
  clear(): void {
    this.listeners.clear()
  }
}
