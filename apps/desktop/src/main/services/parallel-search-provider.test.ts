import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parseMcpMessages,
  pickResponseEnvelope,
  extractToolPayload,
  McpStreamableHttpClient,
  ParallelSearchProvider,
  validatePublicHttpUrl,
} from "./parallel-search-provider.js"

// ---------------------------------------------------------------------------
// parseMcpMessages
// ---------------------------------------------------------------------------
describe("parseMcpMessages", () => {
  it("returns empty array for empty / blank input", () => {
    assert.deepStrictEqual(parseMcpMessages(""), [])
    assert.deepStrictEqual(parseMcpMessages("   "), [])
    assert.deepStrictEqual(parseMcpMessages(null as unknown as string), [])
    assert.deepStrictEqual(parseMcpMessages(undefined as unknown as string), [])
  })

  it("parses a single JSON object", () => {
    const msg = { jsonrpc: "2.0", id: "1", result: { ok: true } }
    const out = parseMcpMessages(JSON.stringify(msg))
    assert.deepStrictEqual(out, [msg])
  })

  it("parses a JSON array of messages", () => {
    const msgs = [
      { jsonrpc: "2.0", id: "a", result: { x: 1 } },
      { jsonrpc: "2.0", id: "b", error: { code: -1, message: "err" } },
    ]
    const out = parseMcpMessages(JSON.stringify(msgs))
    assert.deepStrictEqual(out, msgs)
  })

  it("parses SSE multi-event with data: lines separated by blank lines", () => {
    const event1 = { jsonrpc: "2.0", id: "1", result: { v: 10 } }
    const event2 = { jsonrpc: "2.0", id: "2", result: { v: 20 } }
    const sse = `data: ${JSON.stringify(event1)}\n\ndata: ${JSON.stringify(event2)}\n`
    const out = parseMcpMessages(sse)
    assert.deepStrictEqual(out, [event1, event2])
  })

  it("parses SSE event with multiple data: lines combined into one message", () => {
    const inner = { line1: "a" }
    const sse = `data: {"line1":\ndata: "a"}\n\n`
    const out = parseMcpMessages(sse)
    assert.deepStrictEqual(out, [inner])
  })

  it("parses SSE event where a data: line contains a JSON array", () => {
    const arr = [{ jsonrpc: "2.0", id: "x", result: { ok: true } }]
    const sse = `data: ${JSON.stringify(arr)}\n\n`
    const out = parseMcpMessages(sse)
    assert.deepStrictEqual(out, arr)
  })

  it("ignores non-data SSE lines (event:, id:, retry:, comments)", () => {
    const msg = { jsonrpc: "2.0", id: "1", result: {} }
    const sse = `event: message\nid: 123\nretry: 5000\n: this is a comment\ndata: ${JSON.stringify(msg)}\n\n`
    const out = parseMcpMessages(sse)
    assert.deepStrictEqual(out, [msg])
  })

  it("handles \\r\\n line endings in SSE", () => {
    const msg = { jsonrpc: "2.0", id: "crlf", result: { ok: true } }
    const sse = `data: ${JSON.stringify(msg)}\r\n\r\n`
    const out = parseMcpMessages(sse)
    assert.deepStrictEqual(out, [msg])
  })

  it("skips SSE data lines that are not valid JSON", () => {
    const valid = { jsonrpc: "2.0", id: "ok", result: { ok: true } }
    const sse = `data: not-json\n\ndata: ${JSON.stringify(valid)}\n\n`
    const out = parseMcpMessages(sse)
    assert.deepStrictEqual(out, [valid])
  })
})

// ---------------------------------------------------------------------------
// pickResponseEnvelope
// ---------------------------------------------------------------------------
describe("pickResponseEnvelope", () => {
  it("returns matching message by requestId", () => {
    const target = { jsonrpc: "2.0", id: "req-42", result: { v: 1 } }
    const messages = [
      { jsonrpc: "2.0", id: "other", result: { v: 2 } },
      target,
      { jsonrpc: "2.0", id: "another", result: { v: 3 } },
    ]
    const out = pickResponseEnvelope(messages, "req-42")
    assert.deepStrictEqual(out, target)
  })

  it("returns last result/error envelope when no id matches", () => {
    const last = { jsonrpc: "2.0", id: "zzz", error: { code: -1, message: "oops" } }
    const messages = [
      { jsonrpc: "2.0", id: "a", result: { v: 1 } },
      { jsonrpc: "2.0", id: "b", result: { v: 2 } },
      last,
    ]
    const out = pickResponseEnvelope(messages, "nonexistent")
    assert.deepStrictEqual(out, last)
  })

  it("returns empty object when no messages have result or error", () => {
    const messages = [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "ping" },
    ]
    const out = pickResponseEnvelope(messages, "x")
    assert.deepStrictEqual(out, {})
  })

  it("returns empty object for empty array", () => {
    assert.deepStrictEqual(pickResponseEnvelope([], "x"), {})
  })

  it("skips null / non-object entries", () => {
    const target = { jsonrpc: "2.0", id: "t", result: { ok: true } }
    const messages = [null, undefined, "string", 42, target] as any[]
    const out = pickResponseEnvelope(messages, "t")
    assert.deepStrictEqual(out, target)
  })

  it("prefers id match over later fallback", () => {
    const early = { jsonrpc: "2.0", id: "match", result: { v: 1 } }
    const late = { jsonrpc: "2.0", id: "zzz", result: { v: 2 } }
    const out = pickResponseEnvelope([late, early], "match")
    assert.deepStrictEqual(out, early)
  })
})

// ---------------------------------------------------------------------------
// extractToolPayload
// ---------------------------------------------------------------------------
describe("extractToolPayload", () => {
  it("returns structuredContent when present", () => {
    const sc = { items: [1, 2, 3] }
    const envelope = { result: { structuredContent: sc } }
    assert.deepStrictEqual(extractToolPayload(envelope), sc)
  })

  it("parses JSON from text content block as fallback", () => {
    const inner = { hello: "world" }
    const envelope = {
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
      },
    }
    assert.deepStrictEqual(extractToolPayload(envelope), inner)
  })

  it("parses JSON from first valid text block when multiple exist", () => {
    const inner = { a: 1 }
    const envelope = {
      result: {
        content: [
          { type: "text", text: "not-json" },
          { type: "text", text: JSON.stringify(inner) },
        ],
      },
    }
    assert.deepStrictEqual(extractToolPayload(envelope), inner)
  })

  it("ignores non-text content blocks", () => {
    const envelope = {
      result: {
        content: [{ type: "image", data: "base64..." }],
      },
    }
    assert.throws(() => extractToolPayload(envelope), /no parseable tool payload/)
  })

  it("throws when result has isError flag", () => {
    const envelope = { result: { isError: true, content: [] } }
    assert.throws(() => extractToolPayload(envelope), /MCP tool error/)
  })

  it("throws when envelope has error", () => {
    const envelope = { error: { code: -32000, message: "server error" } }
    assert.throws(() => extractToolPayload(envelope), /MCP JSON-RPC error/)
  })

  it("throws when no content blocks and no structuredContent", () => {
    const envelope = { result: {} }
    assert.throws(() => extractToolPayload(envelope), /no parseable tool payload/)
  })

  it("throws when result is null", () => {
    const envelope = { result: null }
    assert.throws(() => extractToolPayload(envelope), /no parseable tool payload/)
  })

  it("throws when text block contains non-object JSON (array)", () => {
    const envelope = {
      result: {
        content: [{ type: "text", text: "[1,2,3]" }],
      },
    }
    // Array is typeof object but parsed result is array, check behaviour
    const out = extractToolPayload(envelope)
    // The code checks `parsed && typeof parsed === "object"` — arrays pass this
    assert.deepStrictEqual(out, [1, 2, 3])
  })

  it("throws when text block contains non-object JSON (string)", () => {
    const envelope = {
      result: {
        content: [{ type: "text", text: '"just a string"' }],
      },
    }
    // Parsed is a string, typeof "string" !== "object", falls through
    assert.throws(() => extractToolPayload(envelope), /no parseable tool payload/)
  })

  it("throws when text block contains invalid JSON", () => {
    const envelope = {
      result: {
        content: [{ type: "text", text: "{bad json" }],
      },
    }
    assert.throws(() => extractToolPayload(envelope), /no parseable tool payload/)
  })
})

// ---------------------------------------------------------------------------
// validatePublicHttpUrl
// ---------------------------------------------------------------------------
describe("validatePublicHttpUrl", () => {
  it("accepts a valid public http URL", () => {
    assert.doesNotThrow(() => validatePublicHttpUrl("https://example.com/page"))
  })

  it("accepts a valid public http URL", () => {
    assert.doesNotThrow(() => validatePublicHttpUrl("http://example.com/page"))
  })

  it("rejects ftp protocol", () => {
    assert.throws(() => validatePublicHttpUrl("ftp://example.com/file"), /Unsupported URL protocol/)
  })

  it("rejects file protocol", () => {
    assert.throws(() => validatePublicHttpUrl("file:///etc/passwd"), /Unsupported URL protocol/)
  })

  it("rejects javascript protocol", () => {
    assert.throws(() => validatePublicHttpUrl("javascript:void(0)"), /Unsupported URL protocol/)
  })

  it("rejects localhost hostname", () => {
    assert.throws(() => validatePublicHttpUrl("http://localhost/secret"), /Blocked private\/internal URL/)
  })

  it("rejects 127.x.x.x private IP", () => {
    assert.throws(() => validatePublicHttpUrl("http://127.0.0.1/secret"), /Blocked private\/internal URL/)
  })

  it("rejects 10.x.x.x private IP", () => {
    assert.throws(() => validatePublicHttpUrl("http://10.0.0.1/secret"), /Blocked private\/internal URL/)
  })

  it("rejects 172.16-31.x.x private IP", () => {
    assert.throws(() => validatePublicHttpUrl("http://172.16.0.1/secret"), /Blocked private\/internal URL/)
    assert.throws(() => validatePublicHttpUrl("http://172.31.255.255/secret"), /Blocked private\/internal URL/)
  })

  it("rejects 192.168.x.x private IP", () => {
    assert.throws(() => validatePublicHttpUrl("http://192.168.1.1/secret"), /Blocked private\/internal URL/)
  })

  it("rejects 169.254.x.x link-local IP", () => {
    assert.throws(() => validatePublicHttpUrl("http://169.254.1.1/secret"), /Blocked private\/internal URL/)
  })

  it("rejects 0.0.0.0", () => {
    assert.throws(() => validatePublicHttpUrl("http://0.0.0.0/secret"), /Blocked private\/internal URL/)
  })

  it("rejects .local suffix", () => {
    assert.throws(() => validatePublicHttpUrl("http://myhost.local/page"), /Blocked private\/internal URL/)
  })

  it("rejects .internal suffix", () => {
    assert.throws(() => validatePublicHttpUrl("http://myhost.internal/page"), /Blocked private\/internal URL/)
  })

  it("rejects URL with api_key query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?api_key=secret123"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with token query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?token=abc"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with access_token query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?access_token=xyz"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with auth query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?auth=abc"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with authorization query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?authorization=abc"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with secret query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?secret=mysecret"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with password query param", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?password=12345"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with token in hash fragment", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page#token=abc"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects URL with token after & in query", () => {
    assert.throws(
      () => validatePublicHttpUrl("https://example.com/page?foo=bar&token=abc"),
      /sensitive credential-like query parameters/,
    )
  })

  it("rejects invalid URL string", () => {
    assert.throws(() => validatePublicHttpUrl("not-a-url"), /Invalid URL/)
  })

  it("rejects IPv6 loopback ::1", () => {
    assert.throws(() => validatePublicHttpUrl("http://[::1]/secret"), /Blocked private\/internal URL/)
  })

  it("accepts a public IP like 8.8.8.8", () => {
    assert.doesNotThrow(() => validatePublicHttpUrl("http://8.8.8.8/dns"))
  })

  it("accepts a public IP like 1.1.1.1", () => {
    assert.doesNotThrow(() => validatePublicHttpUrl("http://1.1.1.1/"))
  })

  it("accepts 172.32.x.x (outside private range)", () => {
    assert.doesNotThrow(() => validatePublicHttpUrl("http://172.32.0.1/"))
  })
})

// ---------------------------------------------------------------------------
// ParallelSearchProvider.search
// ---------------------------------------------------------------------------
describe("ParallelSearchProvider.search", () => {
  function mockClient(results: any[]) {
    return {
      callTool: async (_name: string, _args: Record<string, unknown>) => ({ results }),
    }
  }

  it("returns success with mapped results", async () => {
    const raw = [
      { title: "A", url: "https://a.com", excerpts: ["excerpt1", "excerpt2"] },
      { title: "B", url: "https://b.com", excerpts: [] },
    ]
    const provider = new ParallelSearchProvider(mockClient(raw) as any)
    const out = await provider.search("test query")
    assert.equal(out.success, true)
    assert.equal(out.provider, "parallel")
    const data = (out as any).data
    assert.ok(Array.isArray(data.web))
    assert.equal(data.web.length, 2)
    assert.equal(data.web[0].title, "A")
    assert.equal(data.web[0].url, "https://a.com")
    assert.equal(data.web[0].description, "excerpt1 excerpt2")
    assert.equal(data.web[0].position, 1)
    assert.equal(data.web[1].title, "B")
    assert.equal(data.web[1].position, 2)
    assert.equal(data.web[1].description, "")
  })

  it("returns error for empty query", async () => {
    const provider = new ParallelSearchProvider(mockClient([]) as any)
    const out = await provider.search("")
    assert.equal(out.success, false)
    assert.ok((out as any).error)
  })

  it("returns error for whitespace-only query", async () => {
    const provider = new ParallelSearchProvider(mockClient([]) as any)
    const out = await provider.search("   ")
    assert.equal(out.success, false)
    assert.ok((out as any).error)
  })

  it("limits results to the specified limit", async () => {
    const raw = [
      { title: "A", url: "https://a.com", excerpts: [] },
      { title: "B", url: "https://b.com", excerpts: [] },
      { title: "C", url: "https://c.com", excerpts: [] },
      { title: "D", url: "https://d.com", excerpts: [] },
      { title: "E", url: "https://e.com", excerpts: [] },
      { title: "F", url: "https://f.com", excerpts: [] },
    ]
    const provider = new ParallelSearchProvider(mockClient(raw) as any, "test-app", 5, 5)
    const out = await provider.search("query", 3)
    const data = (out as any).data
    assert.equal(data.web.length, 3)
    assert.equal(data.web[0].title, "A")
    assert.equal(data.web[2].title, "C")
  })

  it("clamps limit to maxSearchResults when higher", async () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`,
      url: `https://${i}.com`,
      excerpts: [],
    }))
    const provider = new ParallelSearchProvider(mockClient(raw) as any, "test-app", 3, 5)
    const out = await provider.search("query", 100)
    const data = (out as any).data
    assert.equal(data.web.length, 3)
  })

  it("defaults limit to maxSearchResults when not provided", async () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`,
      url: `https://${i}.com`,
      excerpts: [],
    }))
    const provider = new ParallelSearchProvider(mockClient(raw) as any, "test-app", 4, 5)
    const out = await provider.search("query")
    const data = (out as any).data
    assert.equal(data.web.length, 4)
  })

  it("returns error when client throws", async () => {
    const failing = {
      callTool: async () => {
        throw new Error("network failure")
      },
    }
    const provider = new ParallelSearchProvider(failing as any)
    const out = await provider.search("query")
    assert.equal(out.success, false)
    assert.equal((out as any).error, "network failure")
    assert.equal((out as any).provider, "parallel")
  })

  it("handles missing results array in payload", async () => {
    const noResults = { notResults: true }
    const provider = new ParallelSearchProvider(mockClient(noResults as any) as any)
    const out = await provider.search("query")
    assert.equal(out.success, true)
    assert.deepStrictEqual((out as any).data.web, [])
  })

  it("handles missing excerpts gracefully", async () => {
    const raw = [{ title: "T", url: "https://t.com" }]
    const provider = new ParallelSearchProvider(mockClient(raw) as any)
    const out = await provider.search("query")
    const web = (out as any).data.web
    assert.equal(web.length, 1)
    assert.equal(web[0].description, "")
  })
})

// ---------------------------------------------------------------------------
// ParallelSearchProvider.fetch
// ---------------------------------------------------------------------------
describe("ParallelSearchProvider.fetch", () => {
  function mockFetchClient(results: any[]) {
    return {
      callTool: async (_name: string, _args: Record<string, unknown>) => ({ results }),
    }
  }

  it("returns results preserving input URL order", async () => {
    const raw = [
      { url: "https://b.com", title: "B", full_content: "content-b" },
      { url: "https://a.com", title: "A", full_content: "content-a" },
    ]
    const provider = new ParallelSearchProvider(mockFetchClient(raw) as any)
    const out = await provider.fetch(["https://a.com", "https://b.com"])
    assert.equal(out.success, true)
    const results = (out as any).results
    assert.equal(results.length, 2)
    assert.equal(results[0].url, "https://a.com")
    assert.equal(results[0].content, "content-a")
    assert.equal(results[1].url, "https://b.com")
    assert.equal(results[1].content, "content-b")
  })

  it("fills error for URLs not present in response", async () => {
    const raw = [{ url: "https://a.com", title: "A", full_content: "ok" }]
    const provider = new ParallelSearchProvider(mockFetchClient(raw) as any)
    const out = await provider.fetch(["https://a.com", "https://missing.com"])
    const results = (out as any).results
    assert.equal(results.length, 2)
    assert.equal(results[0].url, "https://a.com")
    assert.equal(results[0].content, "ok")
    assert.equal(results[1].url, "https://missing.com")
    assert.ok(results[1].error)
    assert.match(results[1].error, /extraction failed/)
  })

  it("returns error for empty urls array", async () => {
    const provider = new ParallelSearchProvider(mockFetchClient([]) as any)
    const out = await provider.fetch([])
    assert.equal(out.success, false)
    assert.ok((out as any).error)
  })

  it("returns error for array of empty strings", async () => {
    const provider = new ParallelSearchProvider(mockFetchClient([]) as any)
    const out = await provider.fetch(["", "  "])
    assert.equal(out.success, false)
  })

  it("rejects private IPs in URLs and returns error", async () => {
    const provider = new ParallelSearchProvider(mockFetchClient([]) as any)
    const out = await provider.fetch(["http://127.0.0.1/secret"])
    assert.equal(out.success, false)
    assert.match((out as any).error, /Blocked private\/internal URL/)
  })

  it("rejects localhost URLs", async () => {
    const provider = new ParallelSearchProvider(mockFetchClient([]) as any)
    const out = await provider.fetch(["http://localhost/admin"])
    assert.equal(out.success, false)
    assert.match((out as any).error, /Blocked private\/internal URL/)
  })

  it("rejects URLs with token query param", async () => {
    const provider = new ParallelSearchProvider(mockFetchClient([]) as any)
    const out = await provider.fetch(["https://example.com/page?token=abc"])
    assert.equal(out.success, false)
    assert.match((out as any).error, /sensitive credential-like query parameters/)
  })

  it("limits fetch URLs to maxFetchUrls", async () => {
    const callToolArgs: any[] = []
    const spy = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        callToolArgs.push(args)
        return { results: [] }
      },
    }
    const provider = new ParallelSearchProvider(spy as any, "test-app", 5, 2)
    const urls = ["https://a.com", "https://b.com", "https://c.com", "https://d.com"]
    await provider.fetch(urls)
    assert.equal(callToolArgs.length, 1)
    assert.deepStrictEqual(callToolArgs[0].urls, ["https://a.com", "https://b.com"])
  })

  it("returns error when client throws", async () => {
    const failing = {
      callTool: async () => {
        throw new Error("timeout")
      },
    }
    const provider = new ParallelSearchProvider(failing as any)
    const out = await provider.fetch(["https://example.com"])
    assert.equal(out.success, false)
    assert.equal((out as any).error, "timeout")
  })

  it("uses excerpts as content fallback when full_content missing", async () => {
    const raw = [
      { url: "https://a.com", title: "A", excerpts: ["line1", "line2"] },
    ]
    const provider = new ParallelSearchProvider(mockFetchClient(raw) as any)
    const out = await provider.fetch(["https://a.com"])
    const results = (out as any).results
    assert.equal(results[0].content, "line1\n\nline2")
    assert.equal(results[0].raw_content, "line1\n\nline2")
  })

  it("returns attribution and provider fields", async () => {
    const provider = new ParallelSearchProvider(mockFetchClient([]) as any)
    const out = await provider.fetch(["https://example.com"])
    assert.equal((out as any).provider, "parallel")
    assert.match((out as any).attribution, /Parallel Search MCP/)
  })
})

// ---------------------------------------------------------------------------
// McpStreamableHttpClient headers/session retry
// ---------------------------------------------------------------------------
describe("McpStreamableHttpClient", () => {
  it("does not send Authorization in keyless mode", async () => {
    const { calls, restore } = installFetchMock([
      mcpResponse({ id: "init", result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s1" }),
      new Response("", { status: 202 }),
      mcpResponse({ id: "tool", result: { structuredContent: { ok: true } } }),
    ])
    try {
      const client = new McpStreamableHttpClient({ clientName: "test", clientVersion: "1.0.0" })
      await client.callTool("web_search", {})
      assert.equal(calls.some((call) => headerValue(call.init.headers, "Authorization")), false)
    } finally {
      restore()
    }
  })

  it("sends Authorization when apiKey is configured", async () => {
    const { calls, restore } = installFetchMock([
      mcpResponse({ id: "init", result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s1" }),
      new Response("", { status: 202 }),
      mcpResponse({ id: "tool", result: { structuredContent: { ok: true } } }),
    ])
    try {
      const client = new McpStreamableHttpClient({ clientName: "test", clientVersion: "1.0.0", apiKey: "parallel-key" })
      await client.callTool("web_search", {})
      assert.equal(calls.every((call) => headerValue(call.init.headers, "Authorization") === "Bearer parallel-key"), true)
    } finally {
      restore()
    }
  })

  it("re-initializes and retries once after session 404", async () => {
    const { calls, restore } = installFetchMock([
      mcpResponse({ id: "init1", result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s1" }),
      new Response("", { status: 202 }),
      new Response("expired", { status: 404 }),
      mcpResponse({ id: "init2", result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s2" }),
      new Response("", { status: 202 }),
      mcpResponse({ id: "tool2", result: { structuredContent: { retried: true } } }),
    ])
    try {
      const client = new McpStreamableHttpClient({ clientName: "test", clientVersion: "1.0.0" })
      assert.deepStrictEqual(await client.callTool("web_search", {}), { retried: true })
      const methods = calls.map((call) => JSON.parse(String(call.init.body)).method)
      assert.deepStrictEqual(methods, ["initialize", "notifications/initialized", "tools/call", "initialize", "notifications/initialized", "tools/call"])
    } finally {
      restore()
    }
  })
})

function installFetchMock(responses: Response[]): { calls: Array<{ init: RequestInit }>; restore: () => void } {
  const original = globalThis.fetch
  const calls: Array<{ init: RequestInit }> = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init: init ?? {} })
    const response = responses.shift()
    if (!response) throw new Error("unexpected fetch call")
    return response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function mcpResponse(message: Record<string, unknown>, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(message), { status: 200, headers })
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}
