/**
 * Low-level Node.js WebSocket connection using the `ws` package.
 *
 * Responsibilities:
 *  - Connect with Authorization Bearer header
 *  - sendJson / close / ping
 *  - Emit onOpen / onFrame / onClose / onError / onPong
 *  - Native ws ping/pong frames (no no-op ping)
 *  - Connect timeout, idle close, heartbeat / reconnect constants
 *
 * This module MUST NOT know about model, messages, tools, provider events,
 * ConversationStore, or Renderer events.
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §7
 */
import WebSocket from "ws"
import { WS_RUNTIME_CONSTANTS } from "@live2d-agent/agent-core"
import { ConnectionStateError } from "./mimo-errors.js"

/* ------------------------------------------------------------------ */
/*  Public Types                                                       */
/* ------------------------------------------------------------------ */

export type Unsubscribe = () => void

export interface WsCloseEvent {
  code: number
  reason: string
  wasClean: boolean
}

export interface WsConnectInput {
  url: string
  apiKey: string
  /** Optional header overrides (e.g. extra auth headers). */
  headers?: Record<string, string>
  connectTimeoutMs?: number
}

export interface NodeWsConnection {
  /** Open the WebSocket connection. Rejects on timeout or error. */
  connect(input: WsConnectInput): Promise<void>

  /** Send a JSON-serialisable value as a text frame. */
  sendJson(value: unknown): void

  /** Gracefully close the connection. */
  close(code?: number, reason?: string): Promise<void>

  /** Send a native WebSocket ping frame. */
  ping(): void

  /* ---- Event subscriptions ---- */

  onOpen(cb: () => void): Unsubscribe
  onFrame(cb: (frame: unknown) => void): Unsubscribe
  onClose(cb: (event: WsCloseEvent) => void): Unsubscribe
  onError(cb: (error: unknown) => void): Unsubscribe
  onPong(cb: () => void): Unsubscribe

  /** Get current connection ready state. */
  get readyState(): "connecting" | "open" | "closing" | "closed"
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

type Listener<T> = (value: T) => void

export class NodeWsConnectionImpl implements NodeWsConnection {
  private ws: WebSocket | null = null
  private _readyState: "connecting" | "open" | "closing" | "closed" = "closed"

  private openListeners = new Set<Listener<void>>()
  private frameListeners = new Set<Listener<unknown>>()
  private closeListeners = new Set<Listener<WsCloseEvent>>()
  private errorListeners = new Set<Listener<unknown>>()
  private pongListeners = new Set<Listener<void>>()

  /* ---- Ready State ---- */

  get readyState(): "connecting" | "open" | "closing" | "closed" {
    return this._readyState
  }

  /* ---- Connect ---- */

  connect(input: WsConnectInput): Promise<void> {
    if (this._readyState === "connecting" || this._readyState === "open") {
      return Promise.reject(
        new ConnectionStateError("closed", this._readyState),
      )
    }

    this._readyState = "connecting"

    const timeoutMs = input.connectTimeoutMs ?? WS_RUNTIME_CONSTANTS.CONNECT_TIMEOUT_MS

    return new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${input.apiKey}`,
        ...input.headers,
      }

      const ws = new WebSocket(input.url, {
        headers,
        handshakeTimeout: timeoutMs,
      })

      this.ws = ws

      const timeout = setTimeout(() => {
        this.cleanup()
        reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      timeout.unref?.()

      ws.on("open", () => {
        clearTimeout(timeout)
        this._readyState = "open"
        this.emitOpen()
        resolve()
      })

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const raw = typeof data === "string" ? data : data.toString("utf-8")
          const frame = JSON.parse(raw)
          this.emitFrame(frame)
        } catch {
          // Non-JSON frames are ignored at this layer
        }
      })

      ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(timeout)
        this._readyState = "closed"
        this.emitClose({
          code: code ?? 1005,
          reason: reason?.toString("utf-8") ?? "",
          wasClean: code === 1000,
        })
      })

      ws.on("error", (err: Error) => {
        clearTimeout(timeout)
        this.emitError(err)
        reject(err)
      })

      ws.on("pong", () => {
        this.emitPong()
      })
    })
  }

  /* ---- Send ---- */

  sendJson(value: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionStateError("open", this._readyState)
    }
    this.ws.send(JSON.stringify(value))
  }

  /* ---- Close ---- */

  close(code?: number, reason?: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.ws || this._readyState === "closed") {
        this._readyState = "closed"
        resolve()
        return
      }

      this._readyState = "closing"

      const timeout = setTimeout(() => {
        this.cleanup()
        this._readyState = "closed"
        resolve()
      }, WS_RUNTIME_CONSTANTS.CLOSE_TIMEOUT_MS)
      timeout.unref?.()

      this.ws!.once("close", () => {
        clearTimeout(timeout)
        this._readyState = "closed"
        resolve()
      })

      this.ws!.close(code ?? 1000, reason)
    })
  }

  /* ---- Ping ---- */

  ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping()
    }
  }

  /* ---- Event Subscriptions ---- */

  onOpen(cb: () => void): Unsubscribe {
    this.openListeners.add(cb)
    return () => this.openListeners.delete(cb)
  }

  onFrame(cb: (frame: unknown) => void): Unsubscribe {
    this.frameListeners.add(cb)
    return () => this.frameListeners.delete(cb)
  }

  onClose(cb: (event: WsCloseEvent) => void): Unsubscribe {
    this.closeListeners.add(cb)
    return () => this.closeListeners.delete(cb)
  }

  onError(cb: (error: unknown) => void): Unsubscribe {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  onPong(cb: () => void): Unsubscribe {
    this.pongListeners.add(cb)
    return () => this.pongListeners.delete(cb)
  }

  /* ---- Private Helpers ---- */

  private cleanup(): void {
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch {
        // Ignore close errors during cleanup
      }
      this.ws = null
    }
    this._readyState = "closed"
  }

  private emitOpen(): void {
    for (const cb of this.openListeners) {
      try { cb() } catch { /* swallow listener errors */ }
    }
  }

  private emitFrame(frame: unknown): void {
    for (const cb of this.frameListeners) {
      try { cb(frame) } catch { /* swallow listener errors */ }
    }
  }

  private emitClose(event: WsCloseEvent): void {
    for (const cb of this.closeListeners) {
      try { cb(event) } catch { /* swallow listener errors */ }
    }
  }

  private emitError(error: unknown): void {
    for (const cb of this.errorListeners) {
      try { cb(error) } catch { /* swallow listener errors */ }
    }
  }

  private emitPong(): void {
    for (const cb of this.pongListeners) {
      try { cb() } catch { /* swallow listener errors */ }
    }
  }
}
