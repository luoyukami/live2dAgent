/**
 * WsSessionManager — WebSocket connection lifecycle per conversation.
 *
 * Responsibilities:
 *   1. Maintain a WS session (state machine) per conversation.
 *   2. Connect → init → ready flow.
 *   3. Idle-close timer (auto-close after `IDLE_CLOSE_MS` of inactivity).
 *   4. Heartbeat skeleton (ping/pong).
 *   5. Reconnect skeleton (delay sequence).
 *   6. Track active run / response IDs per session.
 *   7. Emit AgentRuntimeEvent for WS lifecycle changes.
 *
 * See docs/ws_model_communication_architecture.md §3.1 (WsSessionManager), §6, §7.
 */
import type {
  WsSession,
  WsSessionState,
  AgentRuntimeEvent,
  RuntimeErrorPayload,
} from "./ws-types.js"
import type { ModelWsClient } from "./model-ws-client.js"
import type { ModelWsEvent } from "./model-ws-client.js"
import { WS_RUNTIME_CONSTANTS } from "./ws-runtime-constants.js"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RuntimeEventCallback = (event: AgentRuntimeEvent) => void
export type RuntimeEventUnsubscribe = () => void

/** Options for testing: override timing constants. */
export interface WsSessionManagerOptions {
  idleCloseMs?: number
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
  connectTimeoutMs?: number
  /** Override reconnect delays for testing (default: WS_RUNTIME_CONSTANTS.RECONNECT_DELAYS_MS). */
  reconnectDelaysMs?: readonly number[]
}

/* ------------------------------------------------------------------ */
/*  Allowed state transitions (directed graph)                         */
/* ------------------------------------------------------------------ */

const ALLOWED_TRANSITIONS: Record<WsSessionState, readonly WsSessionState[]> = {
  disconnected: ["connecting", "closed", "disconnected"],
  connecting: ["ready", "disconnected", "closed"],
  ready: ["responding", "reconnecting", "closing", "disconnected", "connecting"],
  responding: ["ready", "waiting_tool", "waiting_approval", "reconnecting"],
  waiting_tool: ["responding", "waiting_approval"],
  waiting_approval: ["waiting_tool", "responding", "ready"],
  reconnecting: ["ready", "responding", "disconnected", "closed", "connecting"],
  closing: ["closed", "disconnected"],
  closed: ["disconnected", "connecting", "closed"],
}

/* ------------------------------------------------------------------ */
/*  WsSessionManager                                                   */
/* ------------------------------------------------------------------ */

export class WsSessionManager {
  private sessions = new Map<string, WsSession>()
  private eventListeners = new Set<RuntimeEventCallback>()
  private modelWsClient: ModelWsClient

  private idleCloseMs: number
  private heartbeatIntervalMs: number
  private pongTimeoutMs: number
  private connectTimeoutMs: number
  private reconnectDelaysMs: readonly number[]

  /** Per-session idle timers */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-session heartbeat intervals */
  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>()

  constructor(modelWsClient: ModelWsClient, options?: WsSessionManagerOptions) {
    this.modelWsClient = modelWsClient
    this.idleCloseMs = options?.idleCloseMs ?? WS_RUNTIME_CONSTANTS.IDLE_CLOSE_MS
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? WS_RUNTIME_CONSTANTS.HEARTBEAT_INTERVAL_MS
    this.pongTimeoutMs = options?.pongTimeoutMs ?? WS_RUNTIME_CONSTANTS.PONG_TIMEOUT_MS
    this.connectTimeoutMs = options?.connectTimeoutMs ?? WS_RUNTIME_CONSTANTS.CONNECT_TIMEOUT_MS
    this.reconnectDelaysMs = options?.reconnectDelaysMs ?? WS_RUNTIME_CONSTANTS.RECONNECT_DELAYS_MS

    // Subscribe to low-level model WS events for pong & close forwarding
    this.modelWsClient.onEvent((event: ModelWsEvent) => this.handleModelWsEvent(event))
  }

  /* ---- Event bus ---- */

  onEvent(callback: RuntimeEventCallback): RuntimeEventUnsubscribe {
    this.eventListeners.add(callback)
    return () => {
      this.eventListeners.delete(callback)
    }
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("[WsSessionManager] listener error:", err)
      }
    }
  }

  /* ---- Session lifecycle ---- */

  /**
   * Ensure a session exists for the given conversation.
   * Does NOT connect — call `connect()` separately.
   */
  ensureSession(conversationId: string): WsSession {
    let session = this.sessions.get(conversationId)
    if (!session) {
      session = this.createSession(conversationId)
    }
    return session
  }

  /**
   * Ensure the session is in "ready" state.
   * If disconnected or closed, triggers a fresh connect.
   */
  async ensureReady(conversationId: string): Promise<void> {
    const session = this.ensureSession(conversationId)
    if (session.state === "ready" || session.state === "responding") return
    if (session.state === "reconnecting") {
      // Wait for reconnect to finish (simplified: just wait briefly)
      // In Phase 3, this will properly await the reconnect promise.
      await this.delay(100)
      const currentState = session.state as WsSessionState
      if (currentState !== "ready") {
        throw new Error("Session failed to become ready after reconnecting")
      }
      return
    }
    await this.connect(conversationId)
  }

  /**
   * Open a WS connection for the conversation.
   *
   * Flow:
   *   disconnected → connecting → ready
   */
  async connect(conversationId: string): Promise<void> {
    const session = this.ensureSession(conversationId)
    if (session.state === "ready" || session.state === "responding") return

    this.transition(session, "connecting")

    try {
      // Phase 1: the real WS connect will happen inside ModelWsClient.
      // We await the client here, then init the session.
      await this.modelWsClient.connect({
        url: "ws://localhost",
        timeoutMs: this.connectTimeoutMs,
      })
      await this.modelWsClient.initSession({})

      this.transition(session, "ready")
      this.resetIdleTimer(conversationId)
      this.startHeartbeat(conversationId)
    } catch (err) {
      this.transition(session, "disconnected")
      this.emit({
        type: "ws.error",
        conversationId,
        error: {
          code: "ws_connect_timeout",
          message: err instanceof Error ? err.message : "Connection failed",
          retryable: true,
          cause: err,
        },
      })
      throw err
    }
  }

  /**
   * Gracefully close the session for a conversation.
   *
   * Flow: ready → closing → closed
   */
  async closeSession(conversationId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(conversationId)
    if (!session || session.state === "closed" || session.state === "disconnected") return

    this.transition(session, "closing")
    this.stopIdleTimer(conversationId)
    this.stopHeartbeat(conversationId)

    try {
      await this.modelWsClient.close({ reason: reason ?? "user_requested" })
    } catch {
      // Ignore close errors — we're closing anyway
    }

    this.transition(session, "closed")
    this.emit({ type: "ws.closed", conversationId, reason: reason ?? "user_requested" })
  }

  /* ---- Run tracking ---- */

  setActiveRun(conversationId: string, runId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.activeRunId = runId
    this.updateLastActivity(conversationId)
    this.resetIdleTimer(conversationId)
  }

  clearActiveRun(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.activeRunId = null
    this.updateLastActivity(conversationId)
    this.resetIdleTimer(conversationId)
  }

  setActiveResponse(conversationId: string, responseId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.activeResponseId = responseId
  }

  clearActiveResponse(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.activeResponseId = null
  }

  /**
   * Transition the session to a new state.
   * Used by RunController for tool call lifecycle (responding → waiting_approval → waiting_tool → responding).
   */
  transitionSessionState(conversationId: string, newState: WsSessionState): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    this.transition(session, newState)
  }

  getActiveResponseId(conversationId: string): string | null {
    return this.sessions.get(conversationId)?.activeResponseId ?? null
  }

  getActiveRunId(conversationId: string): string | null {
    return this.sessions.get(conversationId)?.activeRunId ?? null
  }

  /* ---- Remote context ---- */

  getRemoteContextId(conversationId: string): string | null {
    return this.sessions.get(conversationId)?.remoteContextId ?? null
  }

  setRemoteContextId(conversationId: string, id: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.remoteContextId = id
  }

  /* ---- State queries ---- */

  getState(conversationId: string): WsSessionState | undefined {
    return this.sessions.get(conversationId)?.state
  }

  getSession(conversationId: string): WsSession | undefined {
    return this.sessions.get(conversationId)
  }

  /* ---- Activity ---- */

  /**
   * Mark activity on the session — resets the idle timer.
   * Called by RunController when messages arrive.
   */
  updateLastActivity(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.lastActivityAt = Date.now()
    this.resetIdleTimer(conversationId)
  }

  /* ---- Idle close ---- */

  private resetIdleTimer(conversationId: string): void {
    this.stopIdleTimer(conversationId)

    const session = this.sessions.get(conversationId)
    if (!session || session.state !== "ready" || session.activeRunId !== null) return

    const timer = setTimeout(() => {
      this.closeSession(conversationId, "idle")
    }, this.idleCloseMs)
    timer.unref?.()
    this.idleTimers.set(conversationId, timer)
  }

  private stopIdleTimer(conversationId: string): void {
    const timer = this.idleTimers.get(conversationId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.idleTimers.delete(conversationId)
    }
  }

  /* ---- Heartbeat skeleton ---- */

  private startHeartbeat(conversationId: string): void {
    this.stopHeartbeat(conversationId)

    const interval = setInterval(() => {
      const session = this.sessions.get(conversationId)
      if (!session || session.state === "closed" || session.state === "disconnected") {
        this.stopHeartbeat(conversationId)
        return
      }

      // Record ping time
      session.lastPingAt = Date.now()

      // In a real implementation, we would send a ping command via ModelWsClient
      // and expect a "pong" back. For the Phase 1 skeleton, we just track the timestamps.

      // Check pong timeout: if we haven't received a pong within the window
      if (session.lastPongAt !== null && session.lastPingAt !== null) {
        const elapsed = Date.now() - session.lastPingAt
        if (elapsed > this.pongTimeoutMs) {
          // Connection may be dead — enter reconnecting.
          // This is a skeleton for Phase 3.
          this.emit({
            type: "ws.reconnecting",
            conversationId,
            attempt: session.reconnectAttempt + 1,
          })
        }
      }
    }, this.heartbeatIntervalMs)
    interval.unref?.()

    this.heartbeatIntervals.set(conversationId, interval)
  }

  private stopHeartbeat(conversationId: string): void {
    const interval = this.heartbeatIntervals.get(conversationId)
    if (interval !== undefined) {
      clearInterval(interval)
      this.heartbeatIntervals.delete(conversationId)
    }
  }

  /* ---- Reconnect skeleton ---- */

  /**
   * Initiate reconnection for a conversation.
   * Uses the defined delay sequence. Skeleton for Phase 3.
   */
  async startReconnect(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId)
    if (!session) return

    session.reconnectAttempt = 0
    const delays = [...this.reconnectDelaysMs]

    // First, ensure the session is in disconnected state so connect() will attempt a real connection
    if (session.state !== "disconnected" && session.state !== "closed") {
      this.transition(session, "disconnected")
    }

    for (const delay of delays) {
      session.reconnectAttempt += 1
      this.emit({
        type: "ws.reconnecting",
        conversationId,
        attempt: session.reconnectAttempt,
      })

      await this.delay(delay)

      try {
        await this.connect(conversationId)
        // Success — back to ready
        session.reconnectAttempt = 0
        return
      } catch {
        // Try next delay
      }
    }

    // All attempts failed
    session.reconnectAttempt = 0
    this.transition(session, "disconnected")
    this.emit({
      type: "ws.error",
      conversationId,
      error: {
        code: "ws_reconnect_failed",
        message: "WebSocket reconnection failed after maximum attempts",
        retryable: false,
      },
    })
  }

  /* ---- ModelWS event handler ---- */

  private handleModelWsEvent(event: ModelWsEvent): void {
    if (event.type === "pong") {
      for (const session of this.sessions.values()) {
        session.lastPongAt = Date.now()
      }
    }
    // Other events (closed, error) are handled by the RunController
    // or can trigger reconnect logic in future phases.
  }

  /* ---- State machine ---- */

  private transition(session: WsSession, newState: WsSessionState): void {
    const allowed = ALLOWED_TRANSITIONS[session.state]
    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid WS state transition: ${session.state} → ${newState}`,
      )
    }

    const prevState = session.state
    session.state = newState
    session.lastActivityAt = Date.now()

    if (newState === "connecting") {
      this.emit({ type: "ws.connecting", conversationId: session.conversationId })
    } else if (newState === "ready") {
      this.emit({ type: "ws.ready", conversationId: session.conversationId })
      session.openedAt ??= Date.now()
    }
  }

  /* ---- Internal helpers ---- */

  private createSession(conversationId: string): WsSession {
    const now = Date.now()
    const session: WsSession = {
      conversationId,
      connectionId: null,
      state: "disconnected",
      openedAt: null,
      lastActivityAt: now,
      lastPingAt: null,
      lastPongAt: null,
      activeRunId: null,
      activeResponseId: null,
      remoteContextId: null,
      reconnectAttempt: 0,
    }
    this.sessions.set(conversationId, session)
    return session
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Dispose all sessions and timers (for testing / cleanup). */
  dispose(): void {
    for (const convId of this.sessions.keys()) {
      this.stopIdleTimer(convId)
      this.stopHeartbeat(convId)
    }
    this.sessions.clear()
    this.eventListeners.clear()
  }
}

/* ------------------------------------------------------------------ */
/*  Allowed transition table (exported for testing)                    */
/* ------------------------------------------------------------------ */

export { ALLOWED_TRANSITIONS }
