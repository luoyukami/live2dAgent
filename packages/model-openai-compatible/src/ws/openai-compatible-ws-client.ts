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
import WebSocket from "ws"
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
  new(url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }): MinimalWebSocket
}

export interface OpenAiCompatibleWsClientConfig {
  baseUrl: string
  apiKey?: string
  model?: string
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

  /** Cached tool results pending to be sent with the next createResponse. */
  private pendingToolResults: ModelWsToolResultInput[] = []

  constructor(private config: OpenAiCompatibleWsClientConfig) {
    this.protocol = config.protocol ?? new JsonModelWsProtocol()
  }

  async connect(input: ModelWsConnectConfig): Promise<void> {
    if (this.socket?.readyState === 1) return

    const WebSocketCtor = this.config.WebSocketCtor ?? WebSocket as unknown as MinimalWebSocketConstructor
    if (!WebSocketCtor) {
      throw new Error("WebSocket constructor is not available; provide WebSocketCtor in config")
    }

    const url = this.buildWsUrl(input.url)
    const apiKey = input.apiKey ?? this.config.apiKey

    // Pass API key via constructor options (headers) if supported, to avoid putting it in the URL.
    // Node's `ws` module accepts `new WebSocket(url, protocols, options)` with headers.
    // Browser WebSocket does not support options — in that case we simply omit the key from
    // the URL query (already handled by buildWsUrl) and rely on the caller to set auth via
    // a custom WebSocketCtor wrapper or connection-level auth.
    let socket: MinimalWebSocket
    if (apiKey && WebSocketCtor.length >= 3) {
      socket = new WebSocketCtor(url, undefined, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    } else {
      socket = new WebSocketCtor(url)
    }

    await new Promise<void>((resolve, reject) => {
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

  /** No-op for OpenAI Responses WS — session init is implicit via createResponse. */
  async initSession(_input: ModelWsSessionInit): Promise<void> {
    // The OpenAI Responses WebSocket does not require an explicit session.init.
    // Model, instructions, and tools are provided per response.create call.
  }

  async createResponse(input: ModelWsCreateResponseInput): Promise<void> {
    // Build input items: conversation messages + cached tool results as function_call_output
    const inputItems: Array<Record<string, unknown>> = input.messages.map((m) => ({
      type: "message",
      role: m.role,
      content: m.content,
    }))

    // Append cached (pending) tool results as function_call_output items
    if (this.pendingToolResults.length > 0) {
      for (const tr of this.pendingToolResults) {
        inputItems.push({
          type: "function_call_output",
          call_id: tr.toolCallId,
          output: tr.result.contentForModel,
        })
      }
      this.pendingToolResults = []
    }

    // Include tool results passed directly in input
    if (input.toolResults && input.toolResults.length > 0) {
      for (const tr of input.toolResults) {
        inputItems.push({
          type: "function_call_output",
          call_id: tr.toolCallId,
          output: tr.contentForModel,
        })
      }
    }

    this.send({
      type: "response.create",
      model: this.config.model,
      store: false,
      previous_response_id: input.remoteContextId ?? null,
      input: inputItems,
      tools: input.tools,
    })
  }

  async sendToolResult(input: ModelWsToolResultInput): Promise<void> {
    // In OpenAI Responses WS, tool results are not sent as separate messages.
    // Instead, they are included as function_call_output items in the next
    // createResponse call. We cache them here.
    this.pendingToolResults.push(input)
  }

  async ping(): Promise<void> {
    // OpenAI Responses WS does not use a custom ping message.
    // The protocol-level ping/pong is handled by the underlying WebSocket
    // (TCP keepalive / WS ping frames).  If a provider needs application-level
    // ping, override in a subclass.
  }

  async cancelResponse(input: ModelWsCancelInput): Promise<void> {
    this.send({ type: "response.cancel", response_id: input.responseId })
  }

  async close(input: ModelWsCloseInput): Promise<void> {
    if (!this.socket) return
    if (this.socket.readyState === 1) {
      this.socket.close(1000, input.reason)
    }
    this.socket = null
  }

  onEvent(listener: ModelWsEventListener): ModelWsEventUnsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Test helper: access pending tool results. */
  getPendingToolResults(): ModelWsToolResultInput[] {
    return this.pendingToolResults
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
    if (overrideUrl && overrideUrl !== "ws://localhost") {
      // Use override URL as-is without appending api_key query param
      return overrideUrl
    }
    const base = this.config.baseUrl.replace(/\/$/, "")
    const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
    const path = this.config.wsPath ?? "/responses"
    return `${wsBase}${path}`
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
