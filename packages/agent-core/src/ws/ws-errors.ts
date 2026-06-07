/**
 * Runtime error creation helpers for the WS communication layer.
 *
 * Every factory returns a {@link RuntimeErrorPayload} with the correct
 * `code`, a human-readable `message`, and the appropriate `retryable` flag.
 *
 * See docs/ws_model_communication_architecture.md §15.
 */
import type { RuntimeErrorPayload, RuntimeErrorCode } from "./ws-types.js"

export type { RuntimeErrorPayload, RuntimeErrorCode }

/**
 * Create a structured runtime error payload.
 */
export function createRuntimeError(
  code: RuntimeErrorCode,
  message: string,
  options?: { retryable?: boolean; cause?: unknown },
): RuntimeErrorPayload {
  return {
    code,
    message,
    retryable: options?.retryable ?? false,
    cause: options?.cause,
  }
}

/**
 * Pre-built error factories covering every defined error code.
 *
 * Usage:
 * ```ts
 * throw RuntimeErrors.wsConnectTimeout()
 * emit({ type: "run.failed", error: RuntimeErrors.maxToolCallsExceeded() })
 * ```
 */
export const RuntimeErrors = {
  wsConnectTimeout: (cause?: unknown) =>
    createRuntimeError("ws_connect_timeout", "WebSocket connection timed out", { retryable: true, cause }),

  wsClosedUnexpectedly: (cause?: unknown) =>
    createRuntimeError("ws_closed_unexpectedly", "WebSocket closed unexpectedly", { retryable: true, cause }),

  wsReconnectFailed: () =>
    createRuntimeError("ws_reconnect_failed", "WebSocket reconnection failed after maximum attempts"),

  wsProtocolError: (message: string) =>
    createRuntimeError("ws_protocol_error", message),

  remoteContextNotFound: () =>
    createRuntimeError("remote_context_not_found", "Remote context not found on server"),

  responseCancelFailed: () =>
    createRuntimeError("response_cancel_failed", "Failed to cancel response"),

  conversationQueueFull: () =>
    createRuntimeError("conversation_queue_full", "Conversation message queue is full"),

  toolArgumentsInvalid: (message: string) =>
    createRuntimeError("tool_arguments_invalid", message),

  toolExecutionTimeout: (toolName: string) =>
    createRuntimeError("tool_execution_timeout", `Tool execution timed out: ${toolName}`, { retryable: true }),

  toolExecutionFailed: (message: string) =>
    createRuntimeError("tool_execution_failed", message),

  toolPermissionDenied: (toolName: string) =>
    createRuntimeError("tool_permission_denied", `Tool permission denied: ${toolName}`),

  maxToolCallsExceeded: () =>
    createRuntimeError("max_tool_calls_exceeded", "Maximum tool calls per run exceeded"),

  maxModelContinuationsExceeded: () =>
    createRuntimeError("max_model_continuations_exceeded", "Maximum model continuations per run exceeded"),

  contextHardLimitExceeded: () =>
    createRuntimeError("context_hard_limit_exceeded", "Context hard limit exceeded"),

  runReplayFailed: () =>
    createRuntimeError("run_replay_failed", "Run replay failed"),
} as const
