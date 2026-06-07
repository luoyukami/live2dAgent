/**
 * Core WS runtime types for the model communication layer.
 *
 * These types are shared across ConversationManager, WsSessionManager,
 * RunController, and ModelWsClient. They MUST NOT import Electron, React,
 * or Node I/O modules.
 *
 * See docs/ws_model_communication_architecture.md §4–§9.
 */

/* ------------------------------------------------------------------ */
/*  Remote Context                                                     */
/* ------------------------------------------------------------------ */

/** Opaque identifier returned by the model provider for continuation. */
export type RemoteContextId = string

/* ------------------------------------------------------------------ */
/*  Runtime Error                                                      */
/* ------------------------------------------------------------------ */

/** Fixed error codes for the WS runtime layer. */
export type RuntimeErrorCode =
  | "ws_connect_timeout"
  | "ws_closed_unexpectedly"
  | "ws_reconnect_failed"
  | "ws_protocol_error"
  | "remote_context_not_found"
  | "response_cancel_failed"
  | "conversation_queue_full"
  | "tool_arguments_invalid"
  | "tool_execution_timeout"
  | "tool_execution_failed"
  | "tool_permission_denied"
  | "max_tool_calls_exceeded"
  | "max_model_continuations_exceeded"
  | "context_hard_limit_exceeded"
  | "run_replay_failed"

/** Unified runtime error payload (see docs §15). */
export interface RuntimeErrorPayload {
  code: string
  message: string
  retryable: boolean
  cause?: unknown
}

/* ------------------------------------------------------------------ */
/*  WS Protocol types (ModelWsEvent payload)                           */
/* ------------------------------------------------------------------ */

/** Tool call as received from the model via WS. */
export interface WsToolCall {
  id: string
  name: string
  arguments: unknown
}

/** Tool result sent back to the model via WS. */
export interface WsToolResult {
  toolCallId: string
  status: "ok" | "error" | "denied"
  summary: string
  contentForModel: string
  artifactRef?: string
  metadata?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  ModelWsEvent — raw events from the ModelWsClient                   */
/* ------------------------------------------------------------------ */

/**
 * Events emitted by an implementation of ModelWsClient.
 * These are the "wire format" — every provider adapter must convert
 * its own protocol into this shape.
 */
export type ModelWsEvent =
  | { type: "connected" }
  | { type: "session.ready"; remoteSessionId?: string }

  | { type: "response.created"; responseId: string; remoteContextId?: string }
  | { type: "response.text.delta"; responseId: string; delta: string }
  | { type: "response.tool_call.created"; responseId: string; toolCall: WsToolCall }
  | { type: "response.completed"; responseId: string; remoteContextId?: string }
  | { type: "response.cancelled"; responseId: string }

  | { type: "error"; error: RuntimeErrorPayload }
  | { type: "closed"; code?: number; reason?: string }
  | { type: "pong" }

/* ------------------------------------------------------------------ */
/*  AgentRuntimeEvent — internal event protocol                        */
/* ------------------------------------------------------------------ */

/**
 * Internal runtime events emitted by RunController and WsSessionManager.
 * Renderer and business-layer code subscribe to these; they are the
 * single source of truth for UI updates.
 */
export type AgentRuntimeEvent =
  | { type: "ws.connecting"; conversationId: string }
  | { type: "ws.ready"; conversationId: string }
  | { type: "ws.reconnecting"; conversationId: string; attempt: number }
  | { type: "ws.closed"; conversationId: string; reason: string }
  | { type: "ws.error"; conversationId: string; error: RuntimeErrorPayload }

  | { type: "run.queued"; conversationId: string; runId: string }
  | { type: "run.started"; conversationId: string; runId: string }
  | { type: "run.completed"; conversationId: string; runId: string }
  | { type: "run.cancelled"; conversationId: string; runId: string }
  | { type: "run.failed"; conversationId: string; runId: string; error: RuntimeErrorPayload }

  | { type: "assistant.message.created"; conversationId: string; runId: string; messageId: string }
  | { type: "assistant.message.delta"; conversationId: string; runId: string; messageId: string; text: string }
  | { type: "assistant.message.completed"; conversationId: string; runId: string; messageId: string }

  | { type: "tool.call.created"; conversationId: string; runId: string; toolCall: WsToolCall }
  | { type: "tool.call.waiting_approval"; conversationId: string; runId: string; toolCallId: string }
  | { type: "tool.call.started"; conversationId: string; runId: string; toolCallId: string }
  | { type: "tool.call.completed"; conversationId: string; runId: string; toolCallId: string; result: WsToolResult }
  | { type: "tool.call.failed"; conversationId: string; runId: string; toolCallId: string; error: RuntimeErrorPayload }

/* ------------------------------------------------------------------ */
/*  WsSession                                                          */
/* ------------------------------------------------------------------ */

/** All possible states of a WS session (see docs §7). */
export type WsSessionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "responding"
  | "waiting_tool"
  | "waiting_approval"
  | "reconnecting"
  | "closing"
  | "closed"

/** Runtime state for one conversation's WS connection. */
export interface WsSession {
  conversationId: string
  connectionId: string | null
  state: WsSessionState
  openedAt: number | null
  lastActivityAt: number
  lastPingAt: number | null
  lastPongAt: number | null
  activeRunId: string | null
  activeResponseId: string | null
  remoteContextId: string | null
  reconnectAttempt: number
}

/* ------------------------------------------------------------------ */
/*  AgentRun                                                           */
/* ------------------------------------------------------------------ */

/** All possible statuses of a single agent run. */
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_tool"
  | "waiting_approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"

/** One user-message-triggered execution cycle. */
export interface AgentRun {
  id: string
  conversationId: string
  status: AgentRunStatus
  userMessageId: string
  assistantMessageId: string | null
  startedAt: number
  updatedAt: number
  completedAt: number | null
  stepIndex: number
  toolCallCount: number
}

/* ------------------------------------------------------------------ */
/*  ModelWsClient — input / config types                               */
/* ------------------------------------------------------------------ */

export interface ModelWsConnectConfig {
  url: string
  apiKey?: string
  timeoutMs?: number
}

export interface ModelWsSessionInit {
  model?: string
  instructions?: string
  tools?: unknown[]
  metadata?: Record<string, unknown>
}

export interface ModelWsCreateResponseInput {
  responseId?: string
  remoteContextId?: string
  messages: Array<{
    role: "user" | "assistant" | "system"
    content: string
  }>
}

export interface ModelWsToolResultInput {
  responseId: string
  toolCallId: string
  result: WsToolResult
}

export interface ModelWsCancelInput {
  responseId: string
}

export interface ModelWsCloseInput {
  reason?: string
}
