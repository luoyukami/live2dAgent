const PARALLEL_SEARCH_MCP_ENDPOINT = "https://search.parallel.ai/mcp"
const MCP_PROTOCOL_VERSION = "2025-06-18"
const DEFAULT_TIMEOUT_MS = 30_000

type JsonRpcMessage = Record<string, any>

export interface ParallelSearchClientOptions {
  endpoint?: string
  apiKey?: string
  clientName: string
  clientVersion: string
  timeoutMs?: number
}

export class McpStreamableHttpClient {
  private readonly endpoint: string
  private readonly apiKey?: string
  private readonly clientName: string
  private readonly clientVersion: string
  private readonly timeoutMs: number
  private sessionId?: string
  private protocolVersion = MCP_PROTOCOL_VERSION

  constructor(options: ParallelSearchClientOptions) {
    this.endpoint = options.endpoint ?? PARALLEL_SEARCH_MCP_ENDPOINT
    this.apiKey = options.apiKey
    this.clientName = options.clientName
    this.clientVersion = options.clientVersion
    this.timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  }

  async initialize(): Promise<void> {
    const id = crypto.randomUUID()
    const response = await this.postRaw({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
    }, false)

    this.sessionId = response.headers.get("mcp-session-id") ?? undefined
    const messages = parseMcpMessages(await response.text())
    const envelope = pickResponseEnvelope(messages, id)
    const negotiated = envelope?.result?.protocolVersion
    if (typeof negotiated === "string" && negotiated.trim()) this.protocolVersion = negotiated

    await this.sendInitializedNotification()
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.sessionId) await this.initialize()

    const id = crypto.randomUUID()
    let response = await this.postRaw({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }, true)

    if (response.status === 404 && this.sessionId) {
      this.sessionId = undefined
      await this.initialize()
      response = await this.postRaw({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }, true)
    }

    if (!response.ok) {
      const body = await safeReadText(response)
      throw new Error(formatHttpError(response.status, body, Boolean(this.apiKey?.trim())))
    }

    const messages = parseMcpMessages(await response.text())
    const envelope = pickResponseEnvelope(messages, id)
    return extractToolPayload(envelope)
  }

  private async sendInitializedNotification(): Promise<void> {
    await this.postRaw({ jsonrpc: "2.0", method: "notifications/initialized" }, true)
  }

  private headers(includeSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": `${this.clientName}/${this.clientVersion}`,
    }
    if (includeSession && this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    if (includeSession && this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion
    if (this.apiKey?.trim()) headers.Authorization = `Bearer ${this.apiKey.trim()}`
    return headers
  }

  private async postRaw(body: unknown, includeSession: boolean): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(includeSession),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok && !(includeSession && response.status === 404)) {
        const text = await safeReadText(response)
        throw new Error(formatHttpError(response.status, text, Boolean(this.apiKey?.trim())))
      }
      return response
    } finally {
      clearTimeout(timeout)
    }
  }
}

export class ParallelSearchProvider {
  constructor(
    private readonly client: Pick<McpStreamableHttpClient, "callTool">,
    private readonly appName = "live2d-agent",
    private readonly maxSearchResults = 5,
    private readonly maxFetchUrls = 5,
  ) {}

  async search(query: string, limit = this.maxSearchResults): Promise<Record<string, unknown>> {
    const trimmed = query.trim()
    if (!trimmed) return { success: false, error: "query is required" }

    try {
      const payload = await this.client.callTool("web_search", {
        objective: trimmed,
        search_queries: [trimmed],
        session_id: `${this.appName}-${crypto.randomUUID()}`,
      })
      const rawResults = Array.isArray((payload as any).results) ? (payload as any).results : []
      const safeLimit = clampInt(limit, 1, this.maxSearchResults)
      const web = rawResults.slice(0, safeLimit).map((item: any, index: number) => {
        const excerpts = Array.isArray(item?.excerpts) ? item.excerpts : []
        return {
          title: String(item?.title ?? ""),
          url: String(item?.url ?? ""),
          description: excerpts.map(String).join(" "),
          position: index + 1,
        }
      })
      return {
        success: true,
        data: { web },
        provider: "parallel",
        attribution: "Search powered by Parallel Search MCP.",
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), provider: "parallel" }
    }
  }

  async fetch(urls: string[]): Promise<Record<string, unknown>> {
    const safeUrls = urls.filter((url) => typeof url === "string" && url.trim()).map((url) => url.trim()).slice(0, this.maxFetchUrls)
    if (safeUrls.length === 0) return { success: false, error: "urls is required" }
    try {
      for (const url of safeUrls) validatePublicHttpUrl(url)
      const payload = await this.client.callTool("web_fetch", {
        urls: safeUrls,
        full_content: true,
        session_id: `${this.appName}-${crypto.randomUUID()}`,
      })
      const rawResults = Array.isArray((payload as any).results) ? (payload as any).results : []
      const byUrl = new Map<string, any>()
      for (const item of rawResults) if (item?.url) byUrl.set(String(item.url), item)
      const results = safeUrls.map((url) => {
        const item = byUrl.get(url)
        if (!item) return { url, title: "", content: "", raw_content: "", error: "extraction failed: no content returned" }
        const excerpts = Array.isArray(item.excerpts) ? item.excerpts : []
        const content = String(item.full_content ?? excerpts.map(String).join("\n\n") ?? "")
        return { url: String(item.url ?? url), title: String(item.title ?? ""), content, raw_content: content }
      })
      return {
        success: true,
        results,
        provider: "parallel",
        attribution: "Extraction powered by Parallel Search MCP.",
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), provider: "parallel" }
    }
  }
}

export function parseMcpMessages(text: string): JsonRpcMessage[] {
  const body = (text ?? "").trim()
  if (!body) return []
  if (body.startsWith("{") || body.startsWith("[")) {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  const messages: JsonRpcMessage[] = []
  let dataLines: string[] = []
  const flush = (): void => {
    if (dataLines.length === 0) return
    const payload = dataLines.join("\n")
    dataLines = []
    try {
      const parsed = JSON.parse(payload)
      if (Array.isArray(parsed)) messages.push(...parsed)
      else messages.push(parsed)
    } catch {
      // Ignore non-JSON SSE events.
    }
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart())
    else if (line.trim() === "") flush()
  }
  flush()
  return messages
}

export function pickResponseEnvelope(messages: JsonRpcMessage[], requestId: string): JsonRpcMessage {
  let fallback: JsonRpcMessage | undefined
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if (!("result" in message) && !("error" in message)) continue
    if (message.id === requestId) return message
    fallback = message
  }
  return fallback ?? {}
}

export function extractToolPayload(envelope: JsonRpcMessage): Record<string, unknown> {
  if (envelope.error) throw new Error(`MCP JSON-RPC error: ${JSON.stringify(envelope.error).slice(0, 1000)}`)
  const result = envelope.result ?? {}
  if (result.isError) throw new Error(`MCP tool error: ${JSON.stringify(result).slice(0, 1000)}`)
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent
  const blocks = Array.isArray(result.content) ? result.content : []
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      try {
        const parsed = JSON.parse(block.text)
        if (parsed && typeof parsed === "object") return parsed
      } catch {
        // Continue.
      }
    }
  }
  throw new Error("MCP returned no parseable tool payload")
}

export function validatePublicHttpUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  if (/[?&#](?:api[_-]?key|token|access[_-]?token|auth|authorization|password|secret)=/i.test(raw)) {
    throw new Error("Blocked URL containing sensitive credential-like query parameters")
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error(`Blocked private/internal URL: ${raw}`)
  if (isPrivateIp(host)) throw new Error(`Blocked private/internal URL: ${raw}`)
}

function isPrivateIp(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part))
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Number.parseInt(String(value), 10)
  if (Number.isNaN(parsed)) return min
  return Math.max(min, Math.min(max, parsed))
}

function normalizeTimeout(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1_000, Math.min(600_000, value)) : fallback
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function formatHttpError(status: number, body: string, hasApiKey: boolean): string {
  if (status === 401) return hasApiKey ? "Parallel Search MCP authentication failed: API key is invalid or expired" : "Parallel Search MCP anonymous access was rejected"
  if (status === 429) return "Parallel Search MCP rate limit exceeded; set PARALLEL_API_KEY or configure a Parallel API key for higher limits"
  return `MCP HTTP ${status}: ${body.slice(0, 1000)}`
}
