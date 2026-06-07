/**
 * Assistant Runtime Event types.
 *
 * These events are emitted by AssistantRuntime and consumed by
 * AgentRuntimeEventBridge to produce Renderer-facing events.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §12.
 */

import type { AssistantRuntimeError } from "./runtime-errors.js"

/* ------------------------------------------------------------------ */
/*  AssistantRuntimeEvent                                              */
/* ------------------------------------------------------------------ */

/**
 * Events emitted during the lifecycle of an assistant run.
 *
 * Categories:
 *   - Connection: ws.ready / ws.closed
 *   - Run lifecycle: run.started / run.completed / run.failed / run.cancelled
 *   - Message streaming: message.created / message.delta / message.completed
 *   - Tool execution: tool.started / tool.completed / tool.failed
 *   - Queue: run.queued
 */
export type AssistantRuntimeEvent =
  /* ---- Connection ---- */
  | { type: "ws.ready"; conversationId: string }
  | { type: "ws.closed"; conversationId: string; reason: string }

  /* ---- Run lifecycle ---- */
  | { type: "run.started"; conversationId: string; runId: string }
  | { type: "run.completed"; conversationId: string; runId: string }
  | { type: "run.failed"; conversationId: string; runId: string; error: AssistantRuntimeError }
  | { type: "run.cancelled"; conversationId: string; runId: string }
  | { type: "run.queued"; conversationId: string; runId: string }

  /* ---- Message streaming (assistant text) ---- */
  | { type: "message.created"; conversationId: string; runId: string; messageId: string }
  | { type: "message.delta"; conversationId: string; runId: string; messageId: string; delta: string }
  | { type: "message.completed"; conversationId: string; runId: string; messageId: string }

  /* ---- Tool execution ---- */
  | { type: "tool.started"; conversationId: string; runId: string; toolCallId: string; name: string }
  | { type: "tool.completed"; conversationId: string; runId: string; toolCallId: string; summary: string }
  | { type: "tool.failed"; conversationId: string; runId: string; toolCallId: string; error: AssistantRuntimeError }
