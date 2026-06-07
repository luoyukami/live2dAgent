/**
 * MiMo/OpenAI-Compatible WebSocket Runtime.
 *
 * Implements the ProviderRuntime interface by combining:
 *   - NodeWsConnection (low-level WS connection)
 *   - MimoWsProtocol (protocol encode/decode)
 *   - MimoToolSchemaEncoder (tool schema encoding)
 *   - MimoContentEncoder (content part encoding)
 *
 * Responsibilities:
 *   - Hold a session-level WS connection.
 *   - Provide `create()` / `continueWithToolResult()` returning AsyncIterable<ModelEvent>.
 *   - Manage remote response IDs.
 *   - Manage connection health (heartbeat, idle close, reconnect).
 *
 * This module does NOT:
 *   - Execute tools directly.
 *   - Write to ConversationStore.
 *   - Emit Renderer events.
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §6.5, §9
 */
import { WS_RUNTIME_CONSTANTS } from "@live2d-agent/agent-core"
import type {
  ProviderRuntime,
  ProviderRuntimeState,
  CanonicalCreateInput,
  CanonicalToolContinuationInput,
  CanonicalToolResult,
  ModelEvent,
  TokenUsage,
} from "@live2d-agent/agent-core"
import type { NodeWsConnection, WsConnectInput } from "./node-ws-connection.js"
import { MimoWsProtocol } from "./mimo-ws-protocol.js"
import { encodeTools, type ProviderToolSchema } from "./mimo-tool-schema-encoder.js"

/* ------------------------------------------------------------------ */
/*  MimoWsRuntime                                                      */
/* ------------------------------------------------------------------ */

/**
 * Error emitted when a runtime operation fails.
 */
export class RuntimeError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = "RuntimeError"
    this.code = code
    this.retryable = retryable
  }
}

export interface MimoWsRuntimeConfig {
  baseUrl: string
  model: string
  apiKey: string
  connectionFactory?: () => NodeWsConnection
  connectTimeoutMs?: number
}

/**
 * Configuration for a heartbeat cycle.
 */
interface HeartbeatState {
  timer: ReturnType<typeof setInterval> | null
  lastFrameAt: number
  lastPingAt: number | null
  lastPongAt: number | null
  pongTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Configuration for idle close tracking.
 */
interface IdleState {
  timer: ReturnType<typeof setTimeout> | null
  lastActivityAt: number
}

export class MimoWsRuntime implements ProviderRuntime {
  private connection: NodeWsConnection | null = null
  private protocol = new MimoWsProtocol()
  private config!: MimoWsRuntimeConfig

  private _conversationId: string | null = null
  private _remoteResponseId: string | null = null
  private _connectedAt: number | null = null
  private _status: "disconnected" | "connecting" | "connected" | "closed" = "disconnected"

  private heartbeat: HeartbeatState = {
    timer: null,
    lastFrameAt: 0,
    lastPingAt: null,
    lastPongAt: null,
    pongTimer: null,
  }

  private idle: IdleState = {
    timer: null,
    lastActivityAt: 0,
  }

  constructor(config: MimoWsRuntimeConfig) {
    this.configure(config)
  }

  /** Update configuration (safe to call before open). */
  configure(config: MimoWsRuntimeConfig): void {
    this.config = { ...config }
  }

  /* ---- ProviderRuntime implementation ---- */

  async open(conversationId: string): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") {
      throw new RuntimeError("already_open", `Runtime already ${this._status} for conversation "${this._conversationId}"`)
    }

    this._status = "connecting"
    this._conversationId = conversationId
    this.protocol.reset()

    // Build the WS URL from baseUrl
    const wsUrl = this.resolveWsUrl(this.config.baseUrl)

    const connectInput: WsConnectInput = {
      url: wsUrl,
      apiKey: this.config.apiKey,
      connectTimeoutMs: this.config.connectTimeoutMs ?? WS_RUNTIME_CONSTANTS.CONNECT_TIMEOUT_MS,
    }

    const conn = this.config.connectionFactory
      ? this.config.connectionFactory()
      : new (await import("./node-ws-connection.js")).NodeWsConnectionImpl()

    this.connection = conn

    // Wire up frame handler
    conn.onFrame((frame) => {
      this.touchActivity()
      // Frames are handled via AsyncIterable in create/continueWithToolResult
    })

    // Wire up close handler
    conn.onClose((event) => {
      this.stopHeartbeat()
      this.stopIdleTimer()
      this._status = "closed"
    })

    // Wire up pong handler
    conn.onPong(() => {
      this.heartbeat.lastPongAt = Date.now()
      if (this.heartbeat.pongTimer) {
        clearTimeout(this.heartbeat.pongTimer)
        this.heartbeat.pongTimer = null
      }
    })

    // Wire up error handler
    conn.onError((error) => {
      // Errors during connect are propagated via the connect Promise
    })

    await conn.connect(connectInput)

    this._status = "connected"
    this._connectedAt = Date.now()
    this.touchActivity()

    // Start heartbeat & idle timers
    this.startHeartbeat()
    this.startIdleTimer()
  }

  async *create(input: CanonicalCreateInput): AsyncGenerator<ModelEvent> {
    this.ensureConnected()

    const encodedInput = this.protocol.encodeMessages(input.messages)

    // Encode tools
    const encodedTools = encodeTools(input.tools)

    // Build the request
    const request = this.protocol.encodeCreateRequest(
      input.model,
      encodedInput,
      encodedTools,
      input.maxOutputTokens,
      input.remoteResponseId ?? null,
    )

    // Send and stream events
    yield* this.sendAndStream(request)
  }

  async *continueWithToolResult(input: CanonicalToolContinuationInput): AsyncGenerator<ModelEvent> {
    this.ensureConnected()

    const prevResponseId = input.previousResponseId ?? this._remoteResponseId
    if (!prevResponseId) {
      throw new RuntimeError(
        "no_previous_response",
        "Cannot continue tool result without a previous response ID",
      )
    }

    const encodedTools = encodeTools(input.tools)

    const request = this.protocol.encodeContinuationRequest(
      input.model,
      prevResponseId,
      input.toolResult.callId,
      input.toolResult.output,
      encodedTools,
      input.maxOutputTokens,
    )

    yield* this.sendAndStream(request)
  }

  async cancel(input: { responseId?: string; runId: string }): Promise<void> {
    this.ensureConnected()
    this.connection!.sendJson({
      type: "response.cancel",
      response_id: input.responseId ?? this._remoteResponseId ?? "",
    })
  }

  async close(reason: string): Promise<void> {
    this.stopHeartbeat()
    this.stopIdleTimer()
    this.protocol.reset()

    if (this.connection) {
      await this.connection.close(1000, reason)
      this.connection = null
    }

    this._status = "closed"
    this._remoteResponseId = null
    this._connectedAt = null
  }

  getState(): ProviderRuntimeState {
    return {
      status: this._status,
      conversationId: this._conversationId,
      remoteResponseId: this._remoteResponseId,
      connectedAt: this._connectedAt,
    }
  }

  /* ---- Private Helpers ---- */

  private ensureConnected(): void {
    if (this._status !== "connected" || !this.connection) {
      throw new RuntimeError(
        "not_connected",
        "Runtime is not connected. Call open() first.",
      )
    }
  }

  private touchActivity(): void {
    const now = Date.now()
    this.heartbeat.lastFrameAt = now
    this.idle.lastActivityAt = now
  }

  /**
   * Send a request and return an AsyncIterable that yields decoded ModelEvents.
   *
   * Uses an internal frame queue to avoid losing frames that arrive in quick
   * succession before the generator loop can process the previous one.
   */
  private async *sendAndStream(request: object): AsyncGenerator<ModelEvent> {
    this.ensureConnected()
    const conn = this.connection!
    const protocol = this.protocol

    // Frame queue: incoming frames are pushed here, consumer pulls from it.
    const frameQueue: Record<string, unknown>[] = []
    let resolveFrame: ((frame: Record<string, unknown>) => void) | null = null
    let settled = false

    const pushFrame = (record: Record<string, unknown>): void => {
      if (settled) return
      frameQueue.push(record)
      if (resolveFrame) {
        const resolve = resolveFrame
        resolveFrame = null
        const next = frameQueue.shift()!
        resolve(next)
      }
    }

    const unsubscribe = conn.onFrame((frame) => {
      if (typeof frame !== "object" || frame === null) return
      pushFrame(frame as Record<string, unknown>)
    })

    // Also support the "error" event to break out of stuck waits
    const errorUnsubscribe = conn.onError((_error) => {
      // When an error occurs, push a sentinel to unblock the queue
      pushFrame({ type: "response.failed", _internal: true })
    })

    const closeUnsubscribe = conn.onClose((_event) => {
      pushFrame({ type: "response.failed", _internal: true })
    })

    try {
      // Send the request
      conn.sendJson(request)
      this.touchActivity()

      // Stream frames until completed/failed/cancelled
      let done = false
      while (!done) {
        // Get the next frame from the queue (or wait for one)
        let nextFrame: Record<string, unknown>
        if (frameQueue.length > 0) {
          nextFrame = frameQueue.shift()!
        } else {
          nextFrame = await new Promise<Record<string, unknown>>((resolve) => {
            resolveFrame = resolve
          })
        }

        // Skip internal sentinel frames
        if ((nextFrame as Record<string, unknown>)._internal) {
          done = true
          break
        }

        const events = protocol.decode(nextFrame)

        for (const event of events) {
          yield event

          // Track remote response ID and detect terminal events
          if (event.type === "response.created") {
            this._remoteResponseId = event.responseId
          } else if (event.type === "response.completed") {
            this._remoteResponseId = event.responseId
            done = true
          } else if (event.type === "response.failed" || event.type === "response.cancelled") {
            done = true
          }
        }
      }
    } finally {
      settled = true
      unsubscribe()
      errorUnsubscribe()
      closeUnsubscribe()
    }
  }

  private resolveWsUrl(baseUrl: string): string {
    const wsUrl = baseUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/+$/, "")

    return wsUrl.endsWith("/responses") ? wsUrl : `${wsUrl}/responses`
  }

  /* ---- Heartbeat ---- */

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat.lastFrameAt = Date.now()
    this.heartbeat.lastPongAt = Date.now()

    this.heartbeat.timer = setInterval(() => {
      const now = Date.now()

      // If we received any frame in the last HEARTBEAT_INTERVAL_MS, skip ping
      if (now - this.heartbeat.lastFrameAt < WS_RUNTIME_CONSTANTS.HEARTBEAT_INTERVAL_MS) {
        return
      }

      // Send ping
      this.connection?.ping()
      this.heartbeat.lastPingAt = now

      // Set pong timeout
      if (this.heartbeat.pongTimer) {
        clearTimeout(this.heartbeat.pongTimer)
      }
      this.heartbeat.pongTimer = setTimeout(() => {
        // No pong received within PONG_TIMEOUT_MS — connection is likely dead
        this.handleHeartbeatTimeout()
      }, WS_RUNTIME_CONSTANTS.PONG_TIMEOUT_MS)
      this.heartbeat.pongTimer.unref?.()
    }, WS_RUNTIME_CONSTANTS.HEARTBEAT_INTERVAL_MS)
    this.heartbeat.timer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat.timer) {
      clearInterval(this.heartbeat.timer)
      this.heartbeat.timer = null
    }
    if (this.heartbeat.pongTimer) {
      clearTimeout(this.heartbeat.pongTimer)
      this.heartbeat.pongTimer = null
    }
  }

  private handleHeartbeatTimeout(): void {
    // Connection is likely dead — close and let the caller reconnect
    this.close("heartbeat timeout").catch(() => {})
  }

  /* ---- Idle Timer ---- */

  private startIdleTimer(): void {
    this.stopIdleTimer()
    this.idle.lastActivityAt = Date.now()

    this.idle.timer = setTimeout(() => {
      const now = Date.now()
      if (now - this.idle.lastActivityAt >= WS_RUNTIME_CONSTANTS.IDLE_CLOSE_MS) {
        this.close("idle timeout").catch(() => {})
      }
    }, WS_RUNTIME_CONSTANTS.IDLE_CLOSE_MS)
    this.idle.timer.unref?.()
  }

  private stopIdleTimer(): void {
    if (this.idle.timer) {
      clearTimeout(this.idle.timer)
      this.idle.timer = null
    }
  }
}
