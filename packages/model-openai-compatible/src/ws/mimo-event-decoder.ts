/**
 * MiMo/OpenAI-Compatible Event Decoder.
 *
 * Decodes raw provider frames from the WebSocket into canonical ModelEvent
 * objects. For tool calls whose arguments arrive in incremental deltas, the
 * decoder aggregates partial JSON fragments until a valid complete JSON is
 * formed before emitting a `tool.call` event.
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §8.5–8.6
 */

import type { ModelEvent, TokenUsage, ModelError } from "@live2d-agent/agent-core"

/* ------------------------------------------------------------------ */
/*  Tool Call Argument Aggregator                                      */
/* ------------------------------------------------------------------ */

/**
 * Tracks incremental tool call argument deltas and completes them when
 * they form valid JSON.
 *
 * When deltas accumulate to valid JSON and tryComplete() succeeds, the
 * aggregator marks the callId as "emitted" so that a subsequent
 * function_call_arguments.done frame does not produce a duplicate
 * tool.call event.
 */
export class ToolCallArgumentAggregator {
  private buffer: { callId: string; name: string } | null = null
  private raw = ""
  /** Set of callIds that have already been emitted via tryComplete. */
  private emittedIds = new Set<string>()

  /** Feed the next argument delta fragment. */
  feed(callId: string, name: string, delta: string): void {
    if (this.buffer && this.buffer.callId !== callId) {
      // New tool call started — reset
      this.buffer = { callId, name }
      this.raw = delta
    } else if (!this.buffer) {
      this.buffer = { callId, name }
      this.raw = delta
    } else {
      this.raw += delta
    }
  }

  /**
   * Returns a completed tool call event if the buffered arguments now form
   * valid complete JSON, or null if still accumulating.
   */
  tryComplete(responseId: string): ModelEvent | null {
    if (!this.buffer) return null

    // Try to parse the accumulated raw string as JSON
    try {
      JSON.parse(this.raw)
      // Success — valid complete JSON
      const callId = this.buffer.callId
      const event: ModelEvent = {
        type: "tool.call",
        responseId,
        callId,
        name: this.buffer.name,
        argumentsText: this.raw,
      }
      this.emittedIds.add(callId)
      this.reset()
      return event
    } catch {
      // Still not valid JSON — keep accumulating
      return null
    }
  }

  /**
   * Returns true if a tool call with this callId has already been
   * emitted by tryComplete (used by the done-frame decoder to avoid
   * duplicates).
   */
  wasEmitted(callId: string): boolean {
    return this.emittedIds.has(callId)
  }

  /** Forcibly complete (e.g. when response.completed arrives). */
  forceComplete(responseId: string): ModelEvent | null {
    if (!this.buffer) return null
    const callId = this.buffer.callId
    const event: ModelEvent = {
      type: "tool.call",
      responseId,
      callId,
      name: this.buffer.name,
      argumentsText: this.raw,
    }
    this.reset()
    return event
  }

  /** Clear the current buffer (e.g. on response.cancelled). */
  reset(): void {
    this.buffer = null
    this.raw = ""
  }

  /** Full reset including emitted-IDs tracking (use on new response). */
  fullReset(): void {
    this.reset()
    this.emittedIds.clear()
  }
}

/* ------------------------------------------------------------------ */
/*  Decoder                                                            */
/* ------------------------------------------------------------------ */

/**
 * Decode a single provider frame into zero or more ModelEvent objects.
 *
 * Provider frames that map to events:
 *   - response.created        → response.created
 *   - response.output_text.delta → text.delta
 *   - response.function_call_arguments.delta → accumulated via aggregator
 *   - response.function_call_arguments.done → force complete tool.call
 *   - response.completed / response.done → response.completed
 *   - response.failed → response.failed / default to remote_context_not_found
 *   - response.cancelled → response.cancelled
 *   - error with previous_response_not_found / response_not_found / remote_context_not_found
 *     → response.failed with code "remote_context_not_found", retryable: true
 *
 * @param frame - Raw parsed JSON frame from the provider.
 * @param aggregator - Tool call argument aggregator for incremental deltas.
 * @param responseId - Current active response ID (set when response.created is decoded).
 * @returns Array of decoded ModelEvent objects.
 */
export function decodeFrame(
  frame: Record<string, unknown>,
  aggregator: ToolCallArgumentAggregator,
  responseId: string | null,
): ModelEvent[] {
  const events: ModelEvent[] = []
  const type = String(frame.type ?? "")

  // Helper: extract response ID from various key names
  const extractResponseId = (): string => {
    const response = frame.response as Record<string, unknown> | undefined
    return (
      stringValue(frame.responseId ?? frame.response_id ?? response?.id)
    ) ?? responseId ?? "unknown"
  }

  switch (type) {
    case "response.created":
    case "response.in_progress": {
      const id = extractResponseId()
      events.push({ type: "response.created", responseId: id })
      break
    }

    case "response.output_text.delta": {
      const id = extractResponseId()
      const delta = stringValue(frame.delta ?? frame.text)
      if (delta && id) {
        events.push({ type: "text.delta", responseId: id, delta })
      }
      break
    }

    case "response.function_call_arguments.delta": {
      const id = extractResponseId()
      const callId = stringValue(frame.call_id ?? frame.callId ?? frame.tool_call_id)
      const name = stringValue(frame.name)
      const delta = stringValue(frame.delta ?? frame.arguments)
      if (callId && id) {
        aggregator.feed(callId, name, delta)
        // Try to complete — if the agent sends the whole JSON in one delta
        const completed = aggregator.tryComplete(id)
        if (completed) events.push(completed)
      }
      break
    }

    case "response.function_call_arguments.done": {
      const id = extractResponseId()

      const callId = stringValue(frame.call_id ?? frame.callId)

      // If this callId was already emitted by delta aggregation, skip
      if (callId && aggregator.wasEmitted(callId)) {
        break
      }

      // Force complete any pending argument buffer (from deltas)
      const forced = aggregator.forceComplete(id)

      if (forced) {
        // Delta aggregation had a pending buffer — use that
        events.push(forced)
      } else {
        // No pending deltas — use the inline arguments directly
        const name = stringValue(frame.name)
        const args = stringValue(frame.arguments ?? frame.args)
        if (callId && id && args) {
          events.push({
            type: "tool.call",
            responseId: id,
            callId,
            name,
            argumentsText: args,
          })
        }
      }
      break
    }

    case "response.completed":
    case "response.done": {
      const id = extractResponseId()
      // Force complete any pending tool call
      const forced = aggregator.forceComplete(id)
      if (forced) events.push(forced)

      const usage = extractUsage(frame)
      events.push({ type: "response.completed", responseId: id, ...(usage ? { usage } : {}) })
      break
    }

    case "response.failed": {
      const id = extractResponseId()
      aggregator.reset()
      const error = extractError(frame)
      events.push({ type: "response.failed", error })
      break
    }

    case "response.cancelled": {
      const id = extractResponseId()
      aggregator.reset()
      events.push({ type: "response.cancelled", responseId: id })
      break
    }

    case "error": {
      const errObj = (frame.error ?? {}) as Record<string, unknown>
      const errorCode = stringValue(frame.code ?? errObj.code ?? "ws_protocol_error")
      const message = stringValue(frame.message ?? errObj.message ?? "Unknown protocol error")

      // Unify retryable context errors
      const RETRYABLE_CODES = new Set([
        "previous_response_not_found",
        "response_not_found",
        "remote_context_not_found",
      ])

      if (RETRYABLE_CODES.has(errorCode)) {
        events.push({
          type: "response.failed",
          error: {
            code: "remote_context_not_found",
            message: `Remote context not found (${errorCode}): ${message}`,
            retryable: true,
          },
        })
      } else {
        events.push({
          type: "response.failed",
          error: {
            code: errorCode,
            message,
            retryable: Boolean(frame.retryable ?? errObj.retryable ?? false),
          },
        })
      }
      break
    }

    case "connected":
    case "session.created":
    case "session.updated":
    case "pong":
      // These are handled by the connection layer, not the event decoder
      break

    default:
      // Unknown/ignored event types are silently dropped
      break
  }

  return events
}

/* ------------------------------------------------------------------ */
/*  Internal Helpers                                                    */
/* ------------------------------------------------------------------ */

function stringValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  return String(value)
}

function extractUsage(frame: Record<string, unknown>): TokenUsage | undefined {
  const usage = (frame.usage ?? frame.token_usage ?? {}) as Record<string, unknown>
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  if (inputTokens > 0 || outputTokens > 0) {
    return { inputTokens, outputTokens }
  }
  return undefined
}

function extractError(frame: Record<string, unknown>): ModelError {
  const err = (frame.error ?? {}) as Record<string, unknown>
  const code = stringValue(err.code ?? frame.code ?? "response_failed")
  const message = stringValue(err.message ?? frame.message ?? "Response failed")
  const retryable = Boolean(err.retryable ?? frame.retryable ?? false)
  return { code, message, retryable }
}
