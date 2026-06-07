/**
 * Fake WebSocket server for testing MiMo/OpenAI-Compatible WS runtime.
 *
 * Provides:
 *   - A lightweight WS server that accepts a single connection
 *   - Configurable response sequences for each test scenario
 *   - Assertion helpers to inspect received messages
 *   - Built-in ping/pong support
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §15.1
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import type { AddressInfo } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"

/* ------------------------------------------------------------------ */
/*  Public Types                                                       */
/* ------------------------------------------------------------------ */

/**
 * A frame to send to the client at a specific point in the interaction.
 * Can be a static frame or a function that inspects received data.
 */
export type ServerFrame =
  | Record<string, unknown>
  | ((receivedMessages: unknown[]) => Record<string, unknown>)

/**
 * A handler for a specific response step.
 * Receives the parsed message from the client and returns frames to send back.
 */
export interface StepHandler {
  /** Called with the parsed client message. Return frames to send back. */
  handle(message: Record<string, unknown>): Record<string, unknown> | Record<string, unknown>[]
}

export interface FakeWsServerOptions {
  /** Port to listen on (0 = OS-assigned). */
  port?: number
  /** Auto-accept connections. */
  autoAccept?: boolean
  /** Delay before sending responses (ms). */
  responseDelayMs?: number
}

/* ------------------------------------------------------------------ */
/*  FakeWsServer                                                       */
/* ------------------------------------------------------------------ */

export class FakeWsServer {
  private httpServer: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private _port: number = 0
  private _connected = false

  /** Messages received from the client. */
  receivedMessages: unknown[] = []
  /** Frames to send on connection. */
  onConnectFrames: Record<string, unknown>[] = []
  /** Step handlers: each client message invokes the next handler. */
  stepHandlers: StepHandler[] = []
  /** Whether to echo received messages back as pong responses. */
  autoPong = true

  private connectionPromise: Promise<void> | null = null
  private resolveConnection: (() => void) | null = null
  private currentWs: WebSocket | null = null
  private lastUpgradeReq: IncomingMessage | null = null

  get port(): number {
    return this._port
  }

  get connected(): boolean {
    return this._connected
  }

  get upgradeHeaders(): IncomingMessage["headers"] | undefined {
    return this.lastUpgradeReq?.headers
  }

  get upgradeUrl(): string | undefined {
    return this.lastUpgradeReq?.url
  }

  /** Start the server and return the actual port. */
  async start(options?: FakeWsServerOptions): Promise<number> {
    return new Promise<number>((resolve) => {
      this.httpServer = createServer()
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on("connection", (ws, req) => {
        this.lastUpgradeReq = req
        this._connected = true
        this.currentWs = ws
        this.resolveConnection?.()

        // Send on-connect frames
        for (const frame of this.onConnectFrames) {
          ws.send(JSON.stringify(frame))
        }

        // Process incoming messages
        ws.on("message", (data) => {
          const raw = data.toString("utf-8")
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = { _raw: raw }
          }

          this.receivedMessages.push(parsed)

          // Handle ping frames at connection level
          if ((parsed as Record<string, string>).type === "ping") {
            if (this.autoPong) {
              ws.send(JSON.stringify({ type: "pong" }))
            }
            return
          }

          // Handle response.cancel
          if ((parsed as Record<string, string>).type === "response.cancel") {
            ws.send(JSON.stringify({
              type: "response.cancelled",
              response_id: parsed.response_id ?? "unknown",
            }))
            return
          }

          // Route to step handler if available
          if (this.stepHandlers.length > 0) {
            const handler = this.stepHandlers.shift()!
            const frames = handler.handle(parsed)
            const frameArray = Array.isArray(frames) ? frames : [frames]

            if (options?.responseDelayMs && options.responseDelayMs > 0) {
              // Send responses with delay (async)
              this.sendFramesWithDelay(frameArray, options.responseDelayMs, ws)
            } else {
              for (const frame of frameArray) {
                ws.send(JSON.stringify(frame))
              }
            }
          }
        })

        ws.on("close", () => {
          this._connected = false
          this.currentWs = null
        })

        ws.on("pong", () => {
          // Server-side pong received — no-op here
        })

        ws.on("ping", () => {
          // Respond to client ping with pong
          ws.pong()
        })
      })

      this.httpServer.listen(options?.port ?? 0, () => {
        const addr = this.httpServer!.address() as AddressInfo
        this._port = addr.port

        if (options?.autoAccept ?? true) {
          this.connectionPromise = new Promise((resolve) => {
            this.resolveConnection = resolve
          })
        }

        resolve(this._port)
      })
    })
  }

  /** Wait for a client to connect. */
  async waitForConnection(timeoutMs = 5_000): Promise<void> {
    if (this._connected) return

    if (!this.connectionPromise) {
      this.connectionPromise = new Promise((resolve) => {
        this.resolveConnection = resolve
      })
    }

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Connection timeout")), timeoutMs)
    })

    await Promise.race([this.connectionPromise!, timeout])
  }

  /** Send a frame directly to the connected client. */
  send(frame: Record<string, unknown>): void {
    if (this.currentWs?.readyState === WebSocket.OPEN) {
      this.currentWs.send(JSON.stringify(frame))
    }
  }

  /** Add a single-step handler that validates the incoming message. */
  addStep(handler: StepHandler): this {
    this.stepHandlers.push(handler)
    return this
  }

  /** Convenience: add a handler that expects a response.create with specific fields. */
  expectCreate(assertions?: (msg: Record<string, unknown>) => void): this {
    return this.addStep({
      handle(msg) {
        assertions?.(msg)
        return []
      },
    })
  }

  /** Clear all received messages. */
  clearMessages(): void {
    this.receivedMessages = []
  }

  /** Get the last received message. */
  get lastMessage(): Record<string, unknown> | undefined {
    return this.receivedMessages[this.receivedMessages.length - 1] as Record<string, unknown> | undefined
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.currentWs) {
        try {
          this.currentWs.close()
        } catch { /* ignore */ }
        this.currentWs = null
      }

      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve())
          } else {
            resolve()
          }
        })
        this.wss = null
      } else {
        resolve()
      }
    })
  }

  /** Reset state. */
  reset(): void {
    this.receivedMessages = []
    this.onConnectFrames = []
    this.stepHandlers = []
    this._connected = false
    this.connectionPromise = null
    this.resolveConnection = null
    this.currentWs = null
    this.lastUpgradeReq = null
  }

  private async sendFramesWithDelay(
    frames: Record<string, unknown>[],
    delayMs: number,
    ws: WebSocket,
  ): Promise<void> {
    for (const frame of frames) {
      await sleep(delayMs)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame))
      }
    }
  }
}
