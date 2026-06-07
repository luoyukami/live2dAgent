/**
 * AgentRuntimeEventBridge unit tests.
 *
 * Coverage:
 *   1. message.created → emits message.created AgentEvent
 *   2. message.delta → emits message.delta AgentEvent
 *   3. message.completed → emits message.completed + message.added (legacy)
 *   4. run.started → agent.thinking
 *   5. run.completed → agent.idle
 *   6. run.failed → agent.error + agent.idle
 *   7. run.cancelled → agent.idle
 *   8. tool.started → tool.started (AgentAction)
 *   9. tool.completed → tool.finished (ToolResult)
 *  10. tool.failed → tool.error (ToolResult)
 *  11. ws.ready → agent.idle
 *  12. ws.closed → agent.error + agent.idle
 *  13. Empty / no-op events (run.queued) produce no AgentEvent
 *  14. Message deltas are accumulated correctly across multiple chunks
 *  15. subscribe/unsubscribe lifecycle
 *  16. Tool name is remembered from tool.started for completed/failed
 *  17. Concurrent messages don't interfere
 *  18. message.completed without prior .created still emits completed
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { AgentRuntimeEventBridge } from "./agent-runtime-event-bridge.js"
import type {
  AssistantRuntimeEvent,
  AgentEvent,
} from "@live2d-agent/agent-core"

/* ------------------------------------------------------------------ */
/*  Harness                                                            */
/* ------------------------------------------------------------------ */

function createHarness(): {
  bridge: AgentRuntimeEventBridge
  events: AgentEvent[]
  subscribe: () => void
  unsubscribe: () => void
} {
  const bridge = new AgentRuntimeEventBridge()
  const events: AgentEvent[] = []
  const unsub = bridge.subscribe((event) => events.push(event))
  return { bridge, events, subscribe: () => unsub, unsubscribe: unsub }
}

/* ------------------------------------------------------------------ */
/*  Test: Message streaming (created + delta + completed)               */
/* ------------------------------------------------------------------ */

describe("AgentRuntimeEventBridge — message streaming", () => {
  test("message.created → emits message.created AgentEvent with empty content", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "message.created",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
    })
    assert.equal(events.length, 1)
    const ev = events[0]!
    assert.equal(ev.type, "message.created")
    if (ev.type === "message.created") {
      assert.equal(ev.message.id, "msg_1")
      assert.equal(ev.message.role, "assistant")
      assert.equal(ev.message.content, undefined)
      assert.ok(typeof ev.message.createdAt === "number")
    }
  })

  test("message.delta → emits message.delta AgentEvent", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "message.created",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
    })
    events.length = 0 // clear created event

    bridge.process({
      type: "message.delta",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
      delta: "Hello ",
    })
    assert.equal(events.length, 1)
    const ev = events[0]!
    assert.equal(ev.type, "message.delta")
    if (ev.type === "message.delta") {
      assert.equal(ev.messageId, "msg_1")
      assert.equal(ev.delta, "Hello ")
    }
  })

  test("message.completed → message.completed + message.added (backward compat)", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "message.created",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
    })
    events.length = 0 // clear created

    bridge.process({
      type: "message.delta",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
      delta: "Hello ",
    })
    events.length = 0 // clear delta

    bridge.process({
      type: "message.delta",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
      delta: "world!",
    })
    events.length = 0 // clear delta

    bridge.process({
      type: "message.completed",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
    })

    assert.equal(events.length, 2)
    assert.equal(events[0]!.type, "message.completed")
    assert.equal(events[1]!.type, "message.added")

    if (events[0]?.type === "message.completed") {
      assert.equal(events[0].messageId, "msg_1")
    }
    if (events[1]?.type === "message.added") {
      assert.equal(events[1].message.id, "msg_1")
      assert.equal(events[1].message.role, "assistant")
      assert.equal(events[1].message.content, "Hello world!")
      assert.ok(typeof events[1].message.createdAt === "number")
    }
  })

  test("message.completed without prior .created still emits completed", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "message.completed",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "orphan_msg",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "message.completed")
    if (events[0]?.type === "message.completed") {
      assert.equal(events[0].messageId, "orphan_msg")
    }
  })

  test("multiple sequential messages don't interfere — full event sequence", () => {
    const { bridge, events } = createHarness()
    // First message
    bridge.process({
      type: "message.created",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
    })
    bridge.process({
      type: "message.delta",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
      delta: "First",
    })
    // Second message (e.g., after tool continuation)
    bridge.process({
      type: "message.created",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_2",
    })
    bridge.process({
      type: "message.delta",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_2",
      delta: "Second",
    })
    bridge.process({
      type: "message.completed",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_2",
    })
    bridge.process({
      type: "message.completed",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
    })

    // Verify new event types
    const createdEvents = events.filter((e) => e.type === "message.created")
    assert.equal(createdEvents.length, 2)
    const deltaEvents = events.filter((e) => e.type === "message.delta")
    assert.equal(deltaEvents.length, 2)
    const completedEvents = events.filter((e) => e.type === "message.completed")
    assert.equal(completedEvents.length, 2)

    // Verify legacy event
    const addedEvents = events.filter((e) => e.type === "message.added")
    assert.equal(addedEvents.length, 2)
    const firstAdded = addedEvents.find(
      (e): e is AgentEvent & { type: "message.added" } =>
        e.type === "message.added" && e.message.id === "msg_1",
    )
    const secondAdded = addedEvents.find(
      (e): e is AgentEvent & { type: "message.added" } =>
        e.type === "message.added" && e.message.id === "msg_2",
    )
    assert.ok(firstAdded)
    assert.ok(secondAdded)
    if (firstAdded?.type === "message.added") assert.equal(firstAdded.message.content, "First")
    if (secondAdded?.type === "message.added") assert.equal(secondAdded.message.content, "Second")
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Run lifecycle                                                */
/* ------------------------------------------------------------------ */

describe("AgentRuntimeEventBridge — run lifecycle", () => {
  test("run.started → agent.thinking", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "run.started",
      conversationId: "conv_1",
      runId: "run_1",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "agent.thinking")
  })

  test("run.completed → agent.idle", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "run.completed",
      conversationId: "conv_1",
      runId: "run_1",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "agent.idle")
  })

  test("run.failed → agent.error + message.added (error bubble) + agent.idle", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "run.failed",
      conversationId: "conv_1",
      runId: "run_1",
      error: { code: "provider_error", message: "Model error", retryable: true },
    })
    assert.equal(events.length, 3)
    assert.equal(events[0]!.type, "agent.error")
    if (events[0]?.type === "agent.error") {
      assert.equal(events[0].error, "Model error")
    }
    const bubble = events[1]
    assert.equal(bubble?.type, "message.added")
    if (bubble?.type === "message.added") {
      assert.equal(bubble.message.role, "assistant")
      assert.equal(typeof bubble.message.content, "string")
      assert.match(bubble.message.content as string, /Model error/)
      const err = bubble.message.extra?.error as { code?: string; message?: string } | undefined
      assert.equal(err?.code, "provider_error")
      assert.equal(err?.message, "Model error")
    }
    assert.equal(events[2]!.type, "agent.idle")
  })

  test("run.cancelled → agent.idle", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "run.cancelled",
      conversationId: "conv_1",
      runId: "run_1",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "agent.idle")
  })

  test("run.queued → no event emitted", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "run.queued",
      conversationId: "conv_1",
      runId: "run_q_1",
    })
    assert.equal(events.length, 0)
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Tool lifecycle                                               */
/* ------------------------------------------------------------------ */

describe("AgentRuntimeEventBridge — tool lifecycle", () => {
  test("tool.started → tool.started AgentAction", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "tool.started",
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "call_1",
      name: "shell.run",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "tool.started")
    if (events[0]?.type === "tool.started") {
      assert.equal(events[0].action.id, "call_1")
      assert.equal(events[0].action.tool, "shell.run")
      assert.equal(events[0].action.source, "llm")
    }
  })

  test("tool.completed → tool.finished", () => {
    const { bridge, events } = createHarness()
    // Must have tool.started first to remember the name
    bridge.process({
      type: "tool.started",
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "call_1",
      name: "shell.run",
    })
    events.length = 0 // clear

    bridge.process({
      type: "tool.completed",
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "call_1",
      summary: "Executed shell.run",
    })

    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "tool.finished")
    if (events[0]?.type === "tool.finished") {
      assert.equal(events[0].result.actionId, "call_1")
      assert.equal(events[0].result.tool, "shell.run")
      assert.equal(events[0].result.ok, true)
    }
  })

  test("tool.failed → tool.error", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "tool.started",
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "call_2",
      name: "file.read",
    })
    events.length = 0

    bridge.process({
      type: "tool.failed",
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "call_2",
      error: { code: "tool_execution_failed", message: "File not found", retryable: false },
    })

    // Should emit tool.error
    assert.ok(events.length >= 1)
    const errorEvent = events.find((e) => e.type === "tool.error")
    assert.ok(errorEvent)
    if (errorEvent?.type === "tool.error") {
      assert.equal(errorEvent.result.tool, "file.read")
      assert.equal(errorEvent.result.ok, false)
      assert.equal(errorEvent.result.error?.message, "File not found")
    }
  })

  test("tool completed without prior tool.started → uses 'unknown' name", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "tool.completed",
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "call_orphan",
      summary: "Orphaned result",
    })
    assert.equal(events.length, 1)
    if (events[0]?.type === "tool.finished") {
      assert.equal(events[0].result.tool, "unknown")
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Connection events                                            */
/* ------------------------------------------------------------------ */

describe("AgentRuntimeEventBridge — connection events", () => {
  test("ws.ready → agent.idle", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "ws.ready",
      conversationId: "conv_1",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "agent.idle")
  })

  test("ws.closed with abnormal reason → agent.error + error bubble + agent.idle", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "ws.closed",
      conversationId: "conv_1",
      reason: "connection lost",
    })
    assert.equal(events.length, 3)
    assert.equal(events[0]!.type, "agent.error")
    if (events[0]?.type === "agent.error") {
      assert.match(events[0].error, /connection lost/i)
    }
    const bubble = events[1]
    assert.equal(bubble?.type, "message.added")
    if (bubble?.type === "message.added") {
      assert.equal(bubble.message.role, "assistant")
      assert.equal(typeof bubble.message.content, "string")
      assert.match(bubble.message.content as string, /connection lost/i)
      const err = bubble.message.extra?.error as { code?: string } | undefined
      assert.equal(err?.code, "WS_CLOSED")
    }
    assert.equal(events[2]!.type, "agent.idle")
  })

  test("ws.closed with empty reason is treated as abnormal (no false negatives)", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "ws.closed",
      conversationId: "conv_1",
      reason: "",
    })
    // Empty reason should not silently disappear — surface as error.
    assert.equal(events.length, 3)
    assert.equal(events[0]!.type, "agent.error")
    assert.equal(events[1]!.type, "message.added")
    assert.equal(events[2]!.type, "agent.idle")
  })

  test("ws.closed with clean idle close reason → only agent.idle (no error bubble)", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "ws.closed",
      conversationId: "conv_1",
      reason: "user_requested",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "agent.idle")
  })

  test("ws.closed with idle_close reason (alt phrasing) is treated as clean", () => {
    const { bridge, events } = createHarness()
    bridge.process({
      type: "ws.closed",
      conversationId: "conv_1",
      reason: "idle_close:5m",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "agent.idle")
  })
})

/* ------------------------------------------------------------------ */
/*  Test: subscribe / unsubscribe lifecycle                            */
/* ------------------------------------------------------------------ */

describe("AgentRuntimeEventBridge — subscription lifecycle", () => {
  test("unsubscribed listener stops receiving events", () => {
    const bridge = new AgentRuntimeEventBridge()
    const events: AgentEvent[] = []
    const unsub = bridge.subscribe((e) => events.push(e))

    bridge.process({ type: "run.started", conversationId: "c", runId: "r" })
    assert.equal(events.length, 1)

    unsub()
    bridge.process({ type: "run.completed", conversationId: "c", runId: "r" })
    assert.equal(events.length, 1) // no new events
  })

  test("clear() empties pending state and listeners", () => {
    const bridge = new AgentRuntimeEventBridge()
    const events: AgentEvent[] = []
    bridge.subscribe((e) => events.push(e))

    // Start a message (now emits message.created)
    bridge.process({
      type: "message.created",
      conversationId: "c",
      runId: "r",
      messageId: "m",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "message.created")

    // Clear should drop the pending message AND listeners
    bridge.clear()
    // Manually reset events so we can verify no more arrive
    events.length = 0

    // Complete (no-op since pending was cleared, and listener was removed)
    bridge.process({
      type: "message.completed",
      conversationId: "c",
      runId: "r",
      messageId: "m",
    })

    assert.equal(events.length, 0) // listener was also cleared
  })

  test("listener error does not break subsequent listeners", () => {
    const bridge = new AgentRuntimeEventBridge()
    const order: number[] = []
    bridge.subscribe(() => { order.push(1) })
    bridge.subscribe(() => { throw new Error("Listener error") })
    bridge.subscribe(() => { order.push(2) })

    bridge.process({ type: "run.started", conversationId: "c", runId: "r" })
    assert.deepEqual(order, [1, 2])
  })
})
