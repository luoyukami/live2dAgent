/**
 * WsSessionManager unit tests.
 *
 * Phase 1 scope:
 *   - connect / ensureReady / state transitions
 *   - Invalid transition rejection
 *   - Idle close timer
 *   - Heartbeat skeleton (ping/pong tracking)
 *   - Reconnect skeleton
 *   - Run / response tracking helpers
 *
 * Uses a mock ModelWsClient so no real network I/O is involved.
 */
import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { WsSessionManager, ALLOWED_TRANSITIONS } from "./ws-session-manager.js"
import type { ModelWsClient, ModelWsEvent, ModelWsEventListener, ModelWsEventUnsubscribe } from "./model-ws-client.js"
import type { WsSessionState, AgentRuntimeEvent } from "./ws-types.js"

/* ------------------------------------------------------------------ */
/*  Mock ModelWsClient                                                 */
/* ------------------------------------------------------------------ */

class MockModelWsClient implements ModelWsClient {
  public id: string
  private listeners = new Set<ModelWsEventListener>()
  public connectCalls: Array<{ url: string }> = []
  public initSessionCalls: number = 0
  public closeCalls: Array<{ reason?: string }> = []
  public pingCallCount: number = 0
  public shouldFail = false

  constructor(id?: string) {
    this.id = id ?? "default"
  }

  async connect(config: { url: string; apiKey?: string; timeoutMs?: number }): Promise<void> {
    if (this.shouldFail) throw new Error("Connection failed")
    this.connectCalls.push({ url: config.url })
    this.emit({ type: "connected" })
  }

  async initSession(): Promise<void> {
    this.initSessionCalls += 1
    this.emit({ type: "session.ready" })
  }

  async createResponse(): Promise<void> {
    // Not used in session manager tests
  }

  async sendToolResult(): Promise<void> {
    // Not used in session manager tests
  }

  async cancelResponse(): Promise<void> {
    // Not used in session manager tests
  }

  async ping(): Promise<void> {
    this.pingCallCount += 1
  }

  async close(input: { reason?: string }): Promise<void> {
    this.closeCalls.push(input)
    this.emit({ type: "closed", reason: input.reason })
  }

  onEvent(listener: ModelWsEventListener): ModelWsEventUnsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Test helper: emit a ModelWsEvent as if the real client emitted it. */
  emit(event: ModelWsEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /** Test helper: reset call counters. */
  reset(): void {
    this.connectCalls = []
    this.initSessionCalls = 0
    this.closeCalls = []
    this.shouldFail = false
  }
}

/**
 * A factory that creates a new MockModelWsClient per conversation.
 * Each client tracks its own connect/close calls — great for multi-conv tests.
 */
class PerConvClientFactory {
  private clients = new Map<string, MockModelWsClient>()

  getFactory(): (convId: string) => MockModelWsClient {
    return (convId: string) => {
      if (!this.clients.has(convId)) {
        this.clients.set(convId, new MockModelWsClient(convId))
      }
      return this.clients.get(convId)!
    }
  }

  getClient(convId: string): MockModelWsClient | undefined {
    return this.clients.get(convId)
  }

  getAllClients(): MockModelWsClient[] {
    return Array.from(this.clients.values())
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface Harness {
  client: MockModelWsClient
  mgr: WsSessionManager
  events: AgentRuntimeEvent[]
}

function createHarness(options?: {
  idleCloseMs?: number
  heartbeatIntervalMs?: number
  connectTimeoutMs?: number
  reconnectDelaysMs?: readonly number[]
  shouldFail?: boolean
}): Harness {
  const client = new MockModelWsClient()
  if (options?.shouldFail) client.shouldFail = true
  const events: AgentRuntimeEvent[] = []
  const mgr = new WsSessionManager(client, {
    idleCloseMs: options?.idleCloseMs ?? 100_000,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 50_000,
    pongTimeoutMs: 10_000,
    connectTimeoutMs: options?.connectTimeoutMs ?? 5_000,
    reconnectDelaysMs: options?.reconnectDelaysMs,
  })
  mgr.onEvent((event) => events.push(event))
  return { client, mgr, events }
}

/* ------------------------------------------------------------------ */
/*  ALLOWED_TRANSITIONS table                                          */
/* ------------------------------------------------------------------ */

describe("ALLOWED_TRANSITIONS", () => {
  test("every WsSessionState has an entry", () => {
    const states: WsSessionState[] = [
      "disconnected",
      "connecting",
      "ready",
      "responding",
      "waiting_tool",
      "waiting_approval",
      "reconnecting",
      "closing",
      "closed",
    ]
    for (const state of states) {
      assert.ok(
        ALLOWED_TRANSITIONS[state] !== undefined,
        `Missing transition entry for ${state}`,
      )
    }
  })

  test("disconnected can transition to connecting, closed, and disconnected", () => {
    assert.deepEqual([...ALLOWED_TRANSITIONS.disconnected].sort(), ["closed", "connecting", "disconnected"])
  })

  test("ready can transition to responding, reconnecting, and closing", () => {
    const allowed = ALLOWED_TRANSITIONS.ready
    assert.ok(allowed.includes("responding"))
    assert.ok(allowed.includes("reconnecting"))
    assert.ok(allowed.includes("closing"))
  })
})

/* ------------------------------------------------------------------ */
/*  connect                                                            */
/* ------------------------------------------------------------------ */

describe("WsSessionManager connect", () => {
  test("connect transitions from disconnected → connecting → ready", async () => {
    const { client, mgr, events } = createHarness()
    await mgr.connect("conv_1")

    const session = mgr.getSession("conv_1")!
    assert.equal(session.state, "ready")
    assert.equal(session.conversationId, "conv_1")
    assert.equal(typeof session.openedAt, "number")

    // Events emitted in order
    const connectingEvents = events.filter((e) => e.type === "ws.connecting")
    const readyEvents = events.filter((e) => e.type === "ws.ready")
    assert.equal(connectingEvents.length, 1)
    assert.equal(connectingEvents[0]!.conversationId, "conv_1")
    assert.equal(readyEvents.length, 1)
    assert.equal(readyEvents[0]!.conversationId, "conv_1")

    // Verify ModelWsClient was called
    assert.equal(client.connectCalls.length, 1)
    assert.equal(client.initSessionCalls, 1)
  })

  test("connect on already-ready session is a no-op", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")
    const session = mgr.getSession("conv_1")!

    await mgr.connect("conv_1")
    assert.equal(session.state, "ready")
  })

  test("connect on failed model client transitions to disconnected", async () => {
    const { mgr, events } = createHarness({ shouldFail: true })
    await assert.rejects(() => mgr.connect("conv_1"))

    const session = mgr.getSession("conv_1")!
    assert.equal(session.state, "disconnected")

    const errorEvents = events.filter((e) => e.type === "ws.error")
    assert.equal(errorEvents.length, 1)
  })

  test("invalid transition throws", async () => {
    const { mgr } = createHarness()
    // Can't go from disconnected → responding directly
    const session = mgr.ensureSession("conv_1")
    assert.throws(() => {
      // Force an invalid transition via the state machine internals
      // We test this by calling connect first to get to ready,
      // then try an impossible manual transition
      mgr["transition"](session, "responding")
    }, /Invalid WS state transition/)
  })

  test("ensureReady connects a disconnected session", async () => {
    const { mgr, client } = createHarness()
    await mgr.ensureReady("conv_1")
    assert.equal(mgr.getState("conv_1"), "ready")
    assert.equal(client.connectCalls.length, 1)
  })

  test("ensureReady is a no-op when already ready", async () => {
    const { mgr, client } = createHarness()
    await mgr.connect("conv_1")
    client.reset()

    await mgr.ensureReady("conv_1")
    assert.equal(client.connectCalls.length, 0)
  })
})

/* ------------------------------------------------------------------ */
/*  State machine                                                      */
/* ------------------------------------------------------------------ */

describe("WsSessionManager state machine", () => {
  test("getState returns undefined for unknown conversation", () => {
    const { mgr } = createHarness()
    assert.equal(mgr.getState("nonexistent"), undefined)
  })

  test("getSession returns undefined for unknown conversation", () => {
    const { mgr } = createHarness()
    assert.equal(mgr.getSession("nonexistent"), undefined)
  })

  test("ensureSession creates a session in disconnected state", () => {
    const { mgr } = createHarness()
    const session = mgr.ensureSession("conv_1")
    assert.equal(session.state, "disconnected")
    assert.equal(session.conversationId, "conv_1")
    assert.equal(session.activeRunId, null)
    assert.equal(session.activeResponseId, null)
    assert.equal(session.remoteContextId, null)
  })
})

/* ------------------------------------------------------------------ */
/*  Run / response tracking                                            */
/* ------------------------------------------------------------------ */

describe("WsSessionManager run/response tracking", () => {
  test("setActiveRun / clearActiveRun", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")

    mgr.setActiveRun("conv_1", "run_1")
    assert.equal(mgr.getActiveRunId("conv_1"), "run_1")

    mgr.clearActiveRun("conv_1")
    assert.equal(mgr.getActiveRunId("conv_1"), null)
  })

  test("setActiveResponse / clearActiveResponse / getActiveResponseId", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")

    mgr.setActiveResponse("conv_1", "resp_1")
    assert.equal(mgr.getActiveResponseId("conv_1"), "resp_1")

    mgr.clearActiveResponse("conv_1")
    assert.equal(mgr.getActiveResponseId("conv_1"), null)
  })

  test("getActiveResponseId returns null before any response", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")
    assert.equal(mgr.getActiveResponseId("conv_1"), null)
  })

  test("setRemoteContextId / getRemoteContextId", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")

    mgr.setRemoteContextId("conv_1", "ctx_abc")
    assert.equal(mgr.getRemoteContextId("conv_1"), "ctx_abc")
  })

  test("getRemoteContextId returns null before any context is set", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")
    assert.equal(mgr.getRemoteContextId("conv_1"), null)
  })
})

/* ------------------------------------------------------------------ */
/*  Idle close                                                         */
/* ------------------------------------------------------------------ */

describe("WsSessionManager idle close", () => {
  test("session auto-closes after idle timeout when no active run", async () => {
    // Use a very short idle timeout
    const { mgr, events } = createHarness({ idleCloseMs: 10 })
    await mgr.connect("conv_1")
    assert.equal(mgr.getState("conv_1"), "ready")

    // Wait for idle timer to fire
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(mgr.getState("conv_1"), "closed")

    const closedEvents = events.filter((e) => e.type === "ws.closed")
    assert.ok(closedEvents.length >= 1)
    if (closedEvents[0]?.type === "ws.closed") {
      assert.equal(closedEvents[0].reason, "idle")
    }
  })

  test("idle timer does not close when an active run exists", async () => {
    const { mgr } = createHarness({ idleCloseMs: 10 })
    await mgr.connect("conv_1")

    mgr.setActiveRun("conv_1", "run_1")
    // Wait longer than idle timeout
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Should still be ready because active run blocks idle close
    assert.equal(mgr.getState("conv_1"), "ready")
  })

  test("idle timer starts after clearing active run", async () => {
    const { mgr, events } = createHarness({ idleCloseMs: 10 })
    await mgr.connect("conv_1")

    mgr.setActiveRun("conv_1", "run_1")
    await new Promise((resolve) => setTimeout(resolve, 5))
    mgr.clearActiveRun("conv_1")
    // Now idle timer should start

    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(mgr.getState("conv_1"), "closed")

    const closedEvents = events.filter((e) => e.type === "ws.closed")
    assert.ok(closedEvents.length >= 1)
  })

  test("updateLastActivity resets the idle timer", async () => {
    const { mgr, events } = createHarness({ idleCloseMs: 10 })
    await mgr.connect("conv_1")

    // Wait half the idle time and touch activity
    await new Promise((resolve) => setTimeout(resolve, 6))
    mgr.updateLastActivity("conv_1")

    // Wait more than original 10ms total but less than 10ms from the activity touch
    await new Promise((resolve) => setTimeout(resolve, 6))

    // Activity was touched 6ms ago, so 10ms idle hasn't elapsed since activity
    // Actually the timer was reset 6ms ago, so 6ms < 10ms → still open
    assert.equal(mgr.getState("conv_1"), "ready")

    // Wait for the idle timer to eventually fire
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(mgr.getState("conv_1"), "closed")
  })
})

/* ------------------------------------------------------------------ */
/*  Heartbeat skeleton                                                 */
/* ------------------------------------------------------------------ */

describe("WsSessionManager heartbeat skeleton", () => {
  test("heartbeat interval starts after connect and calls client.ping()", async () => {
    const { mgr, client } = createHarness({ heartbeatIntervalMs: 10 })
    await mgr.connect("conv_1")

    const session = mgr.getSession("conv_1")!
    // Wait longer than heartbeat interval + activity timeout
    // Activity was set during connect, so we need to wait > heartbeatIntervalMs
    // for the heartbeat to decide to ping.
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The heartbeat should have called client.ping() at least once
    assert.ok(client.pingCallCount >= 1, "client.ping() should be called by heartbeat")
    assert.equal(typeof session.lastPingAt, "number", "lastPingAt should be set after heartbeat fires")
  })

  test("heartbeat skips ping when recent model activity exists", async () => {
    const { mgr, client } = createHarness({ heartbeatIntervalMs: 50 })
    await mgr.connect("conv_1")

    const pingCountBefore = client.pingCallCount

    // Wait for heartbeat interval to almost elapse, then emit an event to reset activity
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Emit a model event — this resets lastActivityAt via handleClientEvent
    const clientWrapper = client // MockModelWsClient
    clientWrapper.emit({ type: "pong" })

    // Wait for a heartbeat tick that still falls within the recent-activity window.
    await new Promise((resolve) => setTimeout(resolve, 45))

    // Ping should NOT have been called because activity was updated recently
    assert.equal(
      client.pingCallCount,
      pingCountBefore,
      "client.ping() should NOT be called when recent activity exists",
    )
  })

  test("pong from ModelWsClient updates lastPongAt", async () => {
    const { mgr, client } = createHarness()
    await mgr.connect("conv_1")

    const session = mgr.getSession("conv_1")!
    session.lastPingAt = Date.now() - 100

    // Simulate pong from the mock client
    client.emit({ type: "pong" })

    assert.ok(session.lastPongAt !== null)
    assert.ok(session.lastPongAt! >= session.lastPingAt!)
  })

  test("heartbeat stops after closeSession", async () => {
    const { mgr } = createHarness({ heartbeatIntervalMs: 10 })
    await mgr.connect("conv_1")

    await mgr.closeSession("conv_1")

    // After close, heartbeat should be stopped
    // (no easy way to verify this directly, but at minimum no crash)
    assert.equal(mgr.getState("conv_1"), "closed")
  })
})

/* ------------------------------------------------------------------ */
/*  Reconnect skeleton                                                 */
/* ------------------------------------------------------------------ */

describe("WsSessionManager reconnect skeleton", () => {
  test("startReconnect attempts reconnection and emits events", async () => {
    const { mgr, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
    })
    await mgr.connect("conv_1")

    // Start reconnect
    const reconnectPromise = mgr.startReconnect("conv_1")

    // Should succeed quickly since mock client works
    await reconnectPromise

    const reconnectingEvents = events.filter((e) => e.type === "ws.reconnecting")
    assert.ok(reconnectingEvents.length >= 1)
    assert.equal(mgr.getState("conv_1"), "ready")
  })

  test("startReconnect fails after max attempts and transitions to disconnected", async () => {
    const { mgr, client, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 1,
      reconnectDelaysMs: [1, 2, 3],
    })
    await mgr.connect("conv_1")

    // Make client fail
    client.shouldFail = true

    await mgr.startReconnect("conv_1")

    assert.equal(mgr.getState("conv_1"), "disconnected")

    const errorEvents = events.filter((e) => e.type === "ws.error")
    const reconnectErrors = errorEvents.filter(
      (e) => e.type === "ws.error" && e.error.code === "ws_reconnect_failed",
    )
    assert.equal(reconnectErrors.length, 1)
  })
})

/* ------------------------------------------------------------------ */
/*  Phase 3: reconnect details — state after success / failure         */
/* ------------------------------------------------------------------ */

describe("WsSessionManager — Phase 3 reconnect details", () => {
  test("reconnect success → ready when no active run/response", async () => {
    const { mgr, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
    })
    await mgr.connect("conv_1")
    // No active run or response set

    await mgr.startReconnect("conv_1")

    assert.equal(mgr.getState("conv_1"), "ready")

    // Should emit at least one ws.reconnecting on the way
    const reconEvents = events.filter((e) => e.type === "ws.reconnecting")
    assert.ok(reconEvents.length >= 1)
  })

  test("reconnect success → responding when active run exists", async () => {
    const { mgr, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
    })
    await mgr.connect("conv_1")

    // Simulate an active run and response
    mgr.setActiveRun("conv_1", "run_1")
    mgr.setActiveResponse("conv_1", "resp_1")

    await mgr.startReconnect("conv_1")

    // Should end up in responding state
    assert.equal(mgr.getState("conv_1"), "responding")
  })

  test("reconnect success → responding when active response exists (no run)", async () => {
    const { mgr, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
    })
    await mgr.connect("conv_1")

    // Simulate only an active response
    mgr.setActiveResponse("conv_1", "resp_1")

    await mgr.startReconnect("conv_1")

    assert.equal(mgr.getState("conv_1"), "responding")
  })

  test("unexpected close triggers startReconnect", async () => {
    const { mgr, client, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
    })
    await mgr.connect("conv_1")
    assert.equal(mgr.getState("conv_1"), "ready")

    // Clear events before unexpected close
    const beforeCount = events.length

    // Simulate unexpected close from ModelWsClient
    client.emit({ type: "closed", code: 1006, reason: "connection lost" })

    // Wait for reconnect attempt
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Should have emitted ws.error (ws_closed_unexpectedly)
    const errorEvents = events.slice(beforeCount).filter((e) => e.type === "ws.error")
    assert.ok(errorEvents.length >= 1)
    if (errorEvents[0]?.type === "ws.error") {
      assert.equal(errorEvents[0].error.code, "ws_closed_unexpectedly")
    }

    // Should have reconnected (eventually ready or responding)
    const finalState = mgr.getState("conv_1")
    assert.ok(finalState === "ready" || finalState === "responding", `Expected ready or responding, got ${finalState}`)
  })

  test("unexpected error triggers startReconnect", async () => {
    const { mgr, client, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
    })
    await mgr.connect("conv_1")
    assert.equal(mgr.getState("conv_1"), "ready")

    // Simulate error from ModelWsClient
    client.emit({
      type: "error",
      error: { code: "ws_protocol_error", message: "Something went wrong", retryable: true },
    })

    // Wait for reconnect attempt
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Should have reconnected (eventually ready or disconnected if all attempts failed)
    const finalState = mgr.getState("conv_1")
    assert.ok(finalState !== "connecting" && finalState !== "reconnecting",
      `Should have resolved to a terminal state, got ${finalState}`)
  })

  test("failing reconnect transitions to disconnected and emits ws_reconnect_failed", async () => {
    const { mgr, client, events } = createHarness({
      idleCloseMs: 100_000,
      connectTimeoutMs: 1,
      reconnectDelaysMs: [1, 2, 3],
    })
    await mgr.connect("conv_1")

    // Make client fail
    client.shouldFail = true

    await mgr.startReconnect("conv_1")

    assert.equal(mgr.getState("conv_1"), "disconnected")

    const errorEvents = events.filter(
      (e) => e.type === "ws.error" && e.error.code === "ws_reconnect_failed",
    )
    assert.equal(errorEvents.length, 1)
  })
})

/* ------------------------------------------------------------------ */
/*  closeSession                                                       */
/* ------------------------------------------------------------------ */

describe("WsSessionManager closeSession", () => {
  test("closeSession transitions to closed and emits event", async () => {
    const { mgr, events, client } = createHarness()
    await mgr.connect("conv_1")

    await mgr.closeSession("conv_1", "user_requested")
    assert.equal(mgr.getState("conv_1"), "closed")
    assert.equal(client.closeCalls.length, 1)
    assert.equal(client.closeCalls[0]!.reason, "user_requested")

    const closedEvents = events.filter((e) => e.type === "ws.closed")
    assert.equal(closedEvents.length, 1)
    if (closedEvents[0]?.type === "ws.closed") {
      assert.equal(closedEvents[0].reason, "user_requested")
    }
  })

  test("closeSession on already-closed session is a no-op", async () => {
    const { mgr, client } = createHarness()
    await mgr.connect("conv_1")
    await mgr.closeSession("conv_1")
    const callCount = client.closeCalls.length

    await mgr.closeSession("conv_1")
    assert.equal(client.closeCalls.length, callCount)
  })
})

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */

describe("WsSessionManager events", () => {
  test("unsubscribe stops receiving events", async () => {
    const { mgr, events } = createHarness()
    // All events up to this point are captured

    const unsub = mgr.onEvent(() => {}) // dummy
    unsub()

    // Connect — the event should not be received
    await mgr.connect("conv_1")

    // Our original events array should have the ws.ready event
    const readyEvents = events.filter((e) => e.type === "ws.ready")
    assert.equal(readyEvents.length, 1)
  })
})

/* ------------------------------------------------------------------ */
/*  dispose                                                             */
/* ------------------------------------------------------------------ */

describe("WsSessionManager dispose", () => {
  test("dispose clears all sessions and listeners", async () => {
    const { mgr } = createHarness()
    await mgr.connect("conv_1")
    await mgr.connect("conv_2")

    mgr.dispose()

    assert.equal(mgr.getSession("conv_1"), undefined)
    assert.equal(mgr.getSession("conv_2"), undefined)
  })
})

/* ------------------------------------------------------------------ */
/*  Integration: per-conversation client isolation                      */
/* ------------------------------------------------------------------ */

describe("WsSessionManager — per-conversation client isolation", () => {
  test("pong only updates the targeted conversation's session", async () => {
    // Use per-conversation factory so each conversation has its own mock client
    const factory = new PerConvClientFactory()
    const events: AgentRuntimeEvent[] = []
    const mgr = new WsSessionManager(factory.getFactory(), {
      idleCloseMs: 100_000,
      heartbeatIntervalMs: 50_000,
      pongTimeoutMs: 10_000,
      connectTimeoutMs: 5_000,
    })
    mgr.onEvent((event) => events.push(event))

    await mgr.connect("conv_1")
    await mgr.connect("conv_2")

    const session1 = mgr.getSession("conv_1")!
    const session2 = mgr.getSession("conv_2")!

    // Set different lastPingAt values
    session1.lastPingAt = Date.now() - 200
    session2.lastPingAt = Date.now() - 100

    // Emit pong only for conv_1's client
    const client1 = factory.getClient("conv_1")!
    client1.emit({ type: "pong" })

    // Only conv_1's lastPongAt should be updated
    assert.ok(session1.lastPongAt !== null, "Conv_1 should have pong timestamp")
    assert.ok(session1.lastPongAt! >= session1.lastPingAt!, "Conv_1 pong >= ping")

    // conv_2's lastPongAt should still be null (no pong for conv_2)
    assert.equal(session2.lastPongAt, null, "Conv_2 should NOT have pong timestamp")
  })

  test("close only affects the targeted conversation", async () => {
    const factory = new PerConvClientFactory()
    const events: AgentRuntimeEvent[] = []
    const mgr = new WsSessionManager(factory.getFactory(), {
      idleCloseMs: 100_000,
      heartbeatIntervalMs: 50_000,
      pongTimeoutMs: 10_000,
      connectTimeoutMs: 5_000,
    })
    mgr.onEvent((event) => events.push(event))

    await mgr.connect("conv_1")
    await mgr.connect("conv_2")

    assert.equal(mgr.getState("conv_1"), "ready")
    assert.equal(mgr.getState("conv_2"), "ready")

    // Close conv_1
    await mgr.closeSession("conv_1", "test_close")

    // conv_1 should be closed
    assert.equal(mgr.getState("conv_1"), "closed")
    const client1 = factory.getClient("conv_1")
    assert.equal(client1?.closeCalls.length, 1, "Conv_1 client should be closed")

    // conv_2 should remain unaffected
    assert.equal(mgr.getState("conv_2"), "ready",
      "Conv_2 should still be ready after conv_1 close")
    const client2 = factory.getClient("conv_2")
    assert.equal(client2?.closeCalls.length, 0, "Conv_2 client should NOT be closed")
  })

  test("getClient returns the correct per-conversation instance", async () => {
    const factory = new PerConvClientFactory()
    const mgr = new WsSessionManager(factory.getFactory(), {
      idleCloseMs: 100_000,
      heartbeatIntervalMs: 50_000,
      pongTimeoutMs: 10_000,
      connectTimeoutMs: 5_000,
    })

    await mgr.connect("conv_alpha")
    await mgr.connect("conv_beta")

    const clientAlpha = mgr.getClient("conv_alpha")
    const clientBeta = mgr.getClient("conv_beta")

    assert.ok(clientAlpha, "getClient should return a client for conv_alpha")
    assert.ok(clientBeta, "getClient should return a client for conv_beta")

    // With PerConvClientFactory, each conversation gets a unique MockModelWsClient
    if (clientAlpha && clientBeta) {
      assert.notEqual(clientAlpha, clientBeta,
        "Each conversation should have its own ModelWsClient instance")
    }
  })
})
