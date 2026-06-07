import type {
  ModelWsCancelInput,
  ModelWsClient,
  ModelWsCloseInput,
  ModelWsConnectConfig,
  ModelWsCreateResponseInput,
  ModelWsEvent,
  ModelWsEventListener,
  ModelWsEventUnsubscribe,
  ModelWsSessionInit,
  ModelWsToolResultInput,
} from "@live2d-agent/agent-core"
import { JsonModelWsProtocol, type OpenAiCompatibleWsProtocol } from "./openai-compatible-ws-protocol.js"

type WsReadyState = 0 | 1 | 2 | 3

interface MinimalWebSocket {
  readonly readyState: WsReadyState
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open", listener: () => void): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(type: "error", listener: (event: unknown) => void): void
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void
}

export interface MinimalWebSocketConstructor {
  new(url: string, protocols?: string | string[]): MinimalWebSocket
}

export interface OpenAiCompatibleWsClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  wsPath?: string
  protocol?: OpenAiCompatibleWsProtocol
  WebSocketCtor?: MinimalWebSocketConstructor
  onRawSend?: (payload: unknown) => void
  onRawReceive?: (payload: unknown) => void
}

export class OpenAiCompatibleWsClient implements ModelWsClient {
  private socket: MinimalWebSocket | null = null
  private listeners = new Set<ModelWsEventListener>()
  private protocol: OpenAiCompatibleWsProtocol

  constructor(private config: OpenAiCompatibleWsClientConfig) {
    this.protocol = config.protocol ?? new JsonModelWsProtocol()
  }

  async connect(input: ModelWsConnectConfig): Promise<void> {
    if (this.socket?.readyState === 1) return

    const WebSocketCtor = this.config.WebSocketCtor ?? (globalThis as any).WebSocket as MinimalWebSocketConstructor | undefined
    if (!WebSocketCtor) {
      throw new Error("WebSocket constructor is not available; provide WebSocketCtor in config")
    }

    const url = this.buildWsUrl(input.url)

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocketCtor(url)
      const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), input.timeoutMs)
      timeout.unref?.()

      socket.addEventListener("open", () => {
        clearTimeout(timeout)
        this.socket = socket
        this.emit({ type: "connected" })
        resolve()
      })
      socket.addEventListener("message", (event) => this.handleMessage(event.data))
      socket.addEventListener("error", (event) => {
        this.emit({ type: "error", error: { code: "ws_protocol_error", message: "WebSocket error", retryable: true, cause: event } })
      })
      socket.addEventListener("close", (event) => {
        this.emit({ type: "closed", code: event.code, reason: event.reason })
      })
    })
  }

  async initSession(input: ModelWsSessionInit): Promise<void> {
    this.send({ type: "session.init", session: { model: this.config.model, ...input } })
  }

  async createResponse(input: ModelWsCreateResponseInput): Promise<void> {
    this.send({ type: "response.create", input })
  }

  async sendToolResult(input: ModelWsToolResultInput): Promise<void> {
    this.send({ type: "tool.result", input })
  }

  async cancelResponse(input: ModelWsCancelInput): Promise<void> {
    this.send({ type: "response.cancel", input })
  }

  async close(input: ModelWsCloseInput): Promise<void> {
    if (!this.socket) return
    if (this.socket.readyState === 1) {
      this.send({ type: "session.close", input })
    }
    this.socket.close(1000, input.reason)
    this.socket = null
  }

  onEvent(listener: ModelWsEventListener): ModelWsEventUnsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private send(payload: Parameters<OpenAiCompatibleWsProtocol["encode"]>[0]): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("WebSocket is not connected")
    }
    this.config.onRawSend?.(payload)
    this.socket.send(this.protocol.encode(payload))
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data)
    this.config.onRawReceive?.(safeJson(text) ?? text)
    const event = this.protocol.decode(text)
    if (event) this.emit(event)
  }

  private emit(event: ModelWsEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private buildWsUrl(overrideUrl?: string): string {
    if (overrideUrl && overrideUrl !== "ws://localhost") return withAuthQuery(overrideUrl, this.config.apiKey)
    const base = this.config.baseUrl.replace(/\/$/, "")
    const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
    const path = this.config.wsPath ?? "/ws"
    return withAuthQuery(`${wsBase}${path}`, this.config.apiKey, this.config.model)
  }
}

function withAuthQuery(url: string, apiKey: string, model?: string): string {
  const parsed = new URL(url)
  if (model && !parsed.searchParams.has("model")) parsed.searchParams.set("model", model)
  if (apiKey) parsed.searchParams.set("api_key", apiKey)
  return parsed.toString()
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
