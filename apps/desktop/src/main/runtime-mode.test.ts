/**
 * `resolveRuntimeMode` — picks the right runtime (ws vs http-legacy) based
 * on the configured `agent.runtimeMode` and `openaiBaseUrl`.
 *
 * Contract:
 *   - http-legacy mode + any URL                → http-legacy
 *   - ws mode + ws(s):// URL                     → ws
 *   - ws mode + http(s):// URL                   → http-legacy (with reason)
 *   - ws mode + empty / non-URL string           → http-legacy (with reason)
 *
 * These tests pin the contract that prevents the silent "404 on WS upgrade"
 * failure seen when a user has `runtimeMode: "ws"` and an HTTP
 * `/chat/completions` baseUrl.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { resolveRuntimeMode } from "./runtime-mode.js"

describe("resolveRuntimeMode — http-legacy stays http-legacy", () => {
  test("http-legacy mode is honoured regardless of baseUrl", () => {
    const res = resolveRuntimeMode("http-legacy", "https://api.openai.com/v1")
    assert.deepEqual(res, { mode: "http-legacy" })
  })

  test("http-legacy mode is honoured even with a ws:// URL", () => {
    const res = resolveRuntimeMode("http-legacy", "wss://mimo.example.com/v1/responses")
    assert.deepEqual(res, { mode: "http-legacy" })
  })
})

describe("resolveRuntimeMode — ws mode + ws(s):// URL", () => {
  test("wss:// URL keeps ws mode", () => {
    const res = resolveRuntimeMode("ws", "wss://mimo.example.com/v1/responses")
    assert.deepEqual(res, { mode: "ws" })
  })

  test("ws:// URL keeps ws mode", () => {
    const res = resolveRuntimeMode("ws", "ws://localhost:8080/v1")
    assert.deepEqual(res, { mode: "ws" })
  })

  test("scheme detection is case-insensitive", () => {
    const res = resolveRuntimeMode("ws", "WSS://Example.Com/v1/responses")
    assert.deepEqual(res, { mode: "ws" })
  })

  test("leading whitespace is tolerated", () => {
    const res = resolveRuntimeMode("ws", "   wss://mimo.example.com/v1/responses")
    assert.deepEqual(res, { mode: "ws" })
  })
})

describe("resolveRuntimeMode — ws mode + http(s):// URL falls back", () => {
  test("https:// URL falls back to http-legacy with a reason", () => {
    const res = resolveRuntimeMode("ws", "https://api.openai.com/v1/chat/completions")
    assert.equal(res.mode, "http-legacy")
    assert.ok(res.fallbackReason, "fallbackReason should be set")
    assert.match(res.fallbackReason ?? "", /ws.*wss.*baseUrl/i)
  })

  test("http:// URL falls back to http-legacy", () => {
    const res = resolveRuntimeMode("ws", "http://localhost:1234/v1/chat/completions")
    assert.equal(res.mode, "http-legacy")
    assert.ok(res.fallbackReason)
  })

  test("empty baseUrl falls back to http-legacy", () => {
    const res = resolveRuntimeMode("ws", "")
    assert.equal(res.mode, "http-legacy")
    assert.ok(res.fallbackReason)
  })

  test("non-URL string falls back to http-legacy", () => {
    const res = resolveRuntimeMode("ws", "not-a-url")
    assert.equal(res.mode, "http-legacy")
    assert.ok(res.fallbackReason)
  })

  test("fallback reason echoes the offending URL so it is debuggable", () => {
    const offending = "https://opencode.ai/zen/go/v1/chat/completions"
    const res = resolveRuntimeMode("ws", offending)
    assert.equal(res.mode, "http-legacy")
    assert.ok(res.fallbackReason?.includes(offending), "fallbackReason should include offending URL")
  })
})
