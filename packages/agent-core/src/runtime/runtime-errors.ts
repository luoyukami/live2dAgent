/**
 * Assistant Runtime error types and factory functions.
 *
 * These errors are emitted via AssistantRuntimeEvent (run.failed, tool.failed)
 * and consumed by AgentRuntimeEventBridge for Renderer display.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §12.
 */

/* ------------------------------------------------------------------ */
/*  Error payload                                                      */
/* ------------------------------------------------------------------ */

export interface AssistantRuntimeError {
  code: string
  message: string
  retryable: boolean
}

/* ------------------------------------------------------------------ */
/*  Error codes                                                        */
/* ------------------------------------------------------------------ */

export type AssistantRuntimeErrorCode =
  | "run_not_found"
  | "conversation_not_found"
  | "conversation_queue_full"
  | "max_tool_calls_exceeded"
  | "max_model_continuations_exceeded"
  | "context_hard_limit_exceeded"
  | "tool_execution_failed"
  | "tool_validation_failed"
  | "tool_doom_loop_blocked"
  | "remote_context_not_found"
  | "run_replay_failed"
  | "provider_error"
  | "cancelled"
  | "internal_error"

/* ------------------------------------------------------------------ */
/*  Factory functions                                                  */
/* ------------------------------------------------------------------ */

export const AssistantRuntimeErrors = {
  runNotFound: (runId: string): AssistantRuntimeError => ({
    code: "run_not_found",
    message: `Run not found: ${runId}`,
    retryable: false,
  }),

  conversationNotFound: (convId: string): AssistantRuntimeError => ({
    code: "conversation_not_found",
    message: `Conversation not found: ${convId}`,
    retryable: false,
  }),

  conversationQueueFull: (): AssistantRuntimeError => ({
    code: "conversation_queue_full",
    message: "Conversation message queue is full (max 8 queued)",
    retryable: false,
  }),

  maxToolCallsExceeded: (limit: number): AssistantRuntimeError => ({
    code: "max_tool_calls_exceeded",
    message: `Maximum tool calls per run (${limit}) exceeded`,
    retryable: false,
  }),

  maxModelContinuationsExceeded: (limit: number): AssistantRuntimeError => ({
    code: "max_model_continuations_exceeded",
    message: `Maximum model continuations per run (${limit}) exceeded`,
    retryable: false,
  }),

  contextHardLimitExceeded: (): AssistantRuntimeError => ({
    code: "context_hard_limit_exceeded",
    message: "Context hard limit exceeded",
    retryable: false,
  }),

  toolExecutionFailed: (message: string): AssistantRuntimeError => ({
    code: "tool_execution_failed",
    message,
    retryable: false,
  }),

  toolValidationFailed: (message: string): AssistantRuntimeError => ({
    code: "tool_validation_failed",
    message,
    retryable: false,
  }),

  toolDoomLoopBlocked: (toolName: string): AssistantRuntimeError => ({
    code: "tool_doom_loop_blocked",
    message: `Doom loop blocked: tool "${toolName}" called with identical arguments`,
    retryable: false,
  }),

  remoteContextNotFound: (): AssistantRuntimeError => ({
    code: "remote_context_not_found",
    message: "Remote context not found on server",
    retryable: true,
  }),

  runReplayFailed: (): AssistantRuntimeError => ({
    code: "run_replay_failed",
    message: "Run replay failed after maximum retries",
    retryable: false,
  }),

  providerError: (message: string, retryable: boolean): AssistantRuntimeError => ({
    code: "provider_error",
    message,
    retryable,
  }),

  cancelled: (): AssistantRuntimeError => ({
    code: "cancelled",
    message: "Run was cancelled",
    retryable: false,
  }),

  internalError: (message: string): AssistantRuntimeError => ({
    code: "internal_error",
    message,
    retryable: false,
  }),
}
