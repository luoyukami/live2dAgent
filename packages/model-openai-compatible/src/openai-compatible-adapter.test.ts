/**
 * Tests for OpenAiCompatibleAdapter — audio attachment expansion,
 * audio-disabled fallback, and base64 redaction.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  OpenAiCompatibleAdapter,
  isAudioUnsupportedError,
  isImageUnsupportedError,
} from "./openai-compatible-adapter.js"
import type {
  AgentMessage,
  AudioContextAttachment,
} from "@live2d-agent/agent-core"

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal AudioContextAttachment for testing.
 * Uses `as AudioContextAttachment` to bypass the need to import
 * AudioArtifactRef (not re-exported from agent-core).
 */
function makeAudioAttachment(
  overrides?: Partial<AudioContextAttachment> & { artifact?: Record<string, unknown> },
): AudioContextAttachment {
  return {
    id: "att_001",
    type: "audio",
    label: "voice",
    mimeType: "audio/wav",
    durationMs: 5000,
    createdAt: Date.now(),
    artifact: {
      id: "art_001",
      kind: "audio",
      path: "/tmp/test-audio.wav",
      mimeType: "audio/wav",
      size: 1024,
      durationMs: 5000,
      createdAt: Date.now(),
    },
    ...overrides,
  } as AudioContextAttachment
}

function makeUserMessage(
  content: string,
  attachments?: AgentMessage["attachments"],
): AgentMessage {
  return {
    id: "msg_user_1",
    role: "user",
    content,
    createdAt: Date.now(),
    attachments,
  }
}

const BASE_CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "gpt-4o-audio",
}

test("reasoning effort is included when configured and omitted for none", () => {
  const low = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    reasoningEffort: "low",
  })
  assert.equal(
    low.buildRequestBodyForTest([makeUserMessage("Hello")], []).reasoning_effort,
    "low",
  )

  const none = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    reasoningEffort: "none",
  })
  assert.equal(
    none.buildRequestBodyForTest([makeUserMessage("Hello")], []).reasoning_effort,
    undefined,
  )
})

/* ------------------------------------------------------------------ */
/*  1. Audio attachment → input_audio content part                     */
/* ------------------------------------------------------------------ */

test("audio attachment produces input_audio content part", () => {
  const audioBytes = new Uint8Array([1, 2, 3, 4])
  const expectedBase64 = Buffer.from(audioBytes).toString("base64")

  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
    audioReader: {
      readAudio(): Uint8Array {
        return audioBytes
      },
    },
  })

  const message = makeUserMessage("Hello", [makeAudioAttachment()])

  const body = adapter.buildRequestBodyForTest([message], [])
  const messages = body.messages as Array<{ role: string; content: unknown }>
  const userMsg = messages.find((m) => m.role === "user")!

  assert.ok(Array.isArray(userMsg.content), "content should be multimodal array")

  const parts = userMsg.content as Array<Record<string, unknown>>

  // First part: text
  assert.equal(parts[0].type, "text")
  assert.equal((parts[0] as { text: string }).text, "Hello")

  // Second part: input_audio
  assert.equal(parts[1].type, "input_audio")
  const audioPart = parts[1] as { input_audio: { data: string; format: string } }
  assert.equal(audioPart.input_audio.data, expectedBase64)
  assert.equal(audioPart.input_audio.format, "wav")
})

/* ------------------------------------------------------------------ */
/*  2. Audio disabled → audio dropped, text preserved                  */
/* ------------------------------------------------------------------ */

test("audio disabled drops audio, preserves text as string", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: false,
    audioReader: {
      readAudio(): Uint8Array {
        return new Uint8Array([1, 2, 3, 4])
      },
    },
  })

  const message = makeUserMessage("Hello from text", [makeAudioAttachment()])

  const body = adapter.buildRequestBodyForTest([message], [])
  const messages = body.messages as Array<{ role: string; content: unknown }>
  const userMsg = messages.find((m) => m.role === "user")!

  assert.equal(typeof userMsg.content, "string", "content should be a plain string")
  assert.equal(userMsg.content, "Hello from text")
})

/* ------------------------------------------------------------------ */
/*  3. webm mime → rejected in send path                               */
/* ------------------------------------------------------------------ */

test("webm attachment is rejected with AUDIO_UNSUPPORTED_FORMAT", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
    audioReader: {
      readAudio(): Uint8Array {
        return new Uint8Array([10, 20])
      },
    },
  })

  const message = makeUserMessage("Audio input", [
    makeAudioAttachment({
      id: "att_002",
      mimeType: "audio/webm",
      durationMs: 3000,
      artifact: {
        id: "art_002",
        kind: "audio",
        path: "/tmp/test-audio.webm",
        mimeType: "audio/webm",
        size: 512,
        durationMs: 3000,
        createdAt: Date.now(),
      },
    }),
  ])

  assert.throws(
    () => adapter.buildRequestBodyForTest([message], []),
    (err: unknown) => {
      assert.ok(err instanceof Error, "should throw an Error")
      assert.ok(
        err.message.includes("wav/mp3") || err.message.includes("audio/webm"),
        `error message should mention webm rejection, got: ${err.message}`,
      )
      return true
    },
  )
})

/* ------------------------------------------------------------------ */
/*  4. redactRequest strips base64 from input_audio.data              */
/* ------------------------------------------------------------------ */

test("redactRequest replaces input_audio.data with placeholder", () => {
  const adapter = new OpenAiCompatibleAdapter(BASE_CONFIG)

  const body = {
    model: "gpt-4o-audio",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "input_audio",
            input_audio: { data: "SGVsbG8gV29ybGQ=", format: "wav" },
          },
        ],
      },
    ],
  }

  const redacted = adapter.redactRequest(body)
  const messages = redacted.messages as Array<{ role: string; content: unknown }>
  const userMsg = messages.find((m) => m.role === "user")!
  const parts = userMsg.content as Array<Record<string, unknown>>
  const audioPart = parts.find((p) => p.type === "input_audio") as {
    input_audio: { data: string; format: string }
  }

  assert.equal(audioPart.input_audio.data, "[omitted base64 data]")
  assert.equal(audioPart.input_audio.format, "wav")
})

/* ------------------------------------------------------------------ */
/*  5. Non-user message with attachments → content unchanged           */
/* ------------------------------------------------------------------ */

test("non-user message with attachments is not expanded", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
    audioReader: {
      readAudio(): Uint8Array {
        return new Uint8Array([1])
      },
    },
  })

  const message: AgentMessage = {
    id: "msg_asst_1",
    role: "assistant",
    content: "Here is a response",
    createdAt: Date.now(),
    attachments: [makeAudioAttachment()],
  }

  const body = adapter.buildRequestBodyForTest([message], [])
  const messages = body.messages as Array<{ role: string; content: unknown }>
  const asstMsg = messages.find((m) => m.role === "assistant")!

  assert.equal(typeof asstMsg.content, "string")
  assert.equal(asstMsg.content, "Here is a response")
})

/* ------------------------------------------------------------------ */
/*  6. User message without attachments → content unchanged            */
/* ------------------------------------------------------------------ */

test("user message without attachments keeps string content", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
  })

  const message = makeUserMessage("Just text, no audio")
  const body = adapter.buildRequestBodyForTest([message], [])
  const messages = body.messages as Array<{ role: string; content: unknown }>
  const userMsg = messages.find((m) => m.role === "user")!

  assert.equal(typeof userMsg.content, "string")
  assert.equal(userMsg.content, "Just text, no audio")
})

/* ------------------------------------------------------------------ */
/*  7. audio/mpeg mime → format "mp3"                                  */
/* ------------------------------------------------------------------ */

test("audio/mpeg mime produces format mp3", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
    audioReader: {
      readAudio(): Uint8Array {
        return new Uint8Array([99])
      },
    },
  })

  const message = makeUserMessage("Voice note", [
    makeAudioAttachment({
      id: "att_mp3",
      mimeType: "audio/mpeg",
      durationMs: 2000,
      artifact: {
        id: "art_mp3",
        kind: "audio",
        path: "/tmp/test-audio.mp3",
        mimeType: "audio/mpeg",
        size: 256,
        durationMs: 2000,
        createdAt: Date.now(),
      },
    }),
  ])

  const body = adapter.buildRequestBodyForTest([message], [])
  const messages = body.messages as Array<{ role: string; content: unknown }>
  const userMsg = messages.find((m) => m.role === "user")!

  assert.ok(Array.isArray(userMsg.content))
  const parts = userMsg.content as Array<Record<string, unknown>>
  const audioPart = parts.find((p) => p.type === "input_audio") as {
    input_audio: { data: string; format: string }
  }
  assert.equal(audioPart.input_audio.format, "mp3")
})

/* ------------------------------------------------------------------ */
/*  8. redactRequest does not mutate the original object               */
/* ------------------------------------------------------------------ */

test("redactRequest returns a new object, does not mutate original", () => {
  const adapter = new OpenAiCompatibleAdapter(BASE_CONFIG)

  const originalData = "SGVsbG8="
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: originalData, format: "wav" },
          },
        ],
      },
    ],
  }

  const redacted = adapter.redactRequest(body)
  const redactedParts = (redacted.messages as Array<{ content: unknown }>)[0]
    .content as Array<Record<string, unknown>>
  const redactedAudio = redactedParts[0] as {
    input_audio: { data: string }
  }

  assert.equal(redactedAudio.input_audio.data, "[omitted base64 data]")

  // Original should be untouched
  const originalParts = (body.messages as Array<{ content: unknown }>)[0]
    .content as Array<Record<string, unknown>>
  const originalAudio = originalParts[0] as {
    input_audio: { data: string }
  }
  assert.equal(originalAudio.input_audio.data, originalData)
})

/* ------------------------------------------------------------------ */
/*  9. audio reader throws → buildRequestBody throws                    */
/* ------------------------------------------------------------------ */

test("audio reader throws → buildRequestBody throws AUDIO_INPUT_ERROR", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
    audioReader: {
      readAudio(): Uint8Array {
        throw new Error("ENOENT: file not found")
      },
    },
  })

  const message = makeUserMessage("Hello", [makeAudioAttachment()])

  assert.throws(
    () => adapter.buildRequestBodyForTest([message], []),
    (err: unknown) => {
      assert.ok(err instanceof Error, "should throw an Error")
      assert.ok(err.message.includes("ENOENT"), `error should include ENOENT, got: ${err.message}`)
      return true
    },
  )
})

/* ------------------------------------------------------------------ */
/*  10. webm + text still rejected                                     */
/* ------------------------------------------------------------------ */

test("audio reader throws when webm AND text exists", () => {
  const adapter = new OpenAiCompatibleAdapter({
    ...BASE_CONFIG,
    audioInputEnabled: true,
    audioReader: {
      readAudio(): Uint8Array {
        return new Uint8Array([1, 2])
      },
    },
  })

  const message = makeUserMessage("Some accompanying text", [
    makeAudioAttachment({
      id: "att_webm",
      mimeType: "audio/webm",
      durationMs: 4000,
      artifact: {
        id: "art_webm",
        kind: "audio",
        path: "/tmp/test.webm",
        mimeType: "audio/webm",
        size: 256,
        durationMs: 4000,
        createdAt: Date.now(),
      },
    }),
  ])

  assert.throws(
    () => adapter.buildRequestBodyForTest([message], []),
    (err: unknown) => {
      assert.ok(err instanceof Error, "should throw an Error")
      assert.ok(
        err.message.includes("audio/webm") || err.message.includes("wav/mp3"),
        `error message should mention webm rejection, got: ${err.message}`,
      )
      return true
    },
  )
})

/* ------------------------------------------------------------------ */
/*  11. isAudioUnsupportedError predicate                              */
/* ------------------------------------------------------------------ */

test("isAudioUnsupportedError predicate matches audio-related errors", () => {
  // Positive cases
  assert.equal(isAudioUnsupportedError("input_audio is not supported"), true)
  assert.equal(isAudioUnsupportedError("model does not support audio"), true)
  assert.equal(isAudioUnsupportedError("voice input is disabled"), true)
  assert.equal(isAudioUnsupportedError("unsupported audio format"), true)
  assert.equal(isAudioUnsupportedError("audio input not available in this model"), true)
  assert.equal(isAudioUnsupportedError("The API does not support audio"), true)
  assert.equal(isAudioUnsupportedError("input_audio field is not allowed"), true)

  // Negative cases — should NOT match
  assert.equal(isAudioUnsupportedError("audiobook chapter unavailable"), false)
  assert.equal(isAudioUnsupportedError("rate limit exceeded"), false)
  assert.equal(isAudioUnsupportedError("invalid request body"), false)
  assert.equal(isAudioUnsupportedError("model not found"), false)
})

/* ------------------------------------------------------------------ */
/*  12. isImageUnsupportedError predicate                              */
/* ------------------------------------------------------------------ */

test("isImageUnsupportedError predicate matches image-related errors", () => {
  // Positive cases
  assert.equal(isImageUnsupportedError("image input is not supported"), true)
  assert.equal(isImageUnsupportedError("vision capability disabled"), true)
  assert.equal(isImageUnsupportedError("multimodal not available"), true)
  assert.equal(isImageUnsupportedError("unsupported content type"), true)

  // Negative cases — should NOT match
  assert.equal(isImageUnsupportedError("input_audio is not supported"), false)
  assert.equal(isImageUnsupportedError("rate limit exceeded"), false)
  assert.equal(isImageUnsupportedError("audio not supported"), false)
})

/* ================================================================== */
/*  Streaming (SSE) tests                                             */
/* ================================================================== */

/**
 * Helper: create a minimal ReadableStream from an array of SSE lines.
 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const text = lines.join("\n") + "\n"
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/**
 * Helper: build a fake fetch that returns a streaming response.
 */
function fakeStreamingFetch(sseBody: string[]) {
  return async (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return new Response(sseStream(sseBody), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  }
}

/* ------------------------------------------------------------------ */
/*  13. Streaming: text-only content                                   */
/* ------------------------------------------------------------------ */

test("streaming query accumulates text deltas and calls onTextDelta", async () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":"!"},"index":0}]}',
    "data: [DONE]",
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeStreamingFetch(sseBody)
  try {
    const deltas: Array<{ messageId: string; delta: string }> = []
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
      callbacks: {
        onTextDelta(messageId, delta) {
          deltas.push({ messageId, delta })
        },
      },
    })

    assert.equal(result.role, "assistant")
    assert.equal(result.content, "Hello world!")
    assert.equal(result.actions, undefined)
    assert.ok(result.id, "message id must be set")
    assert.ok(result.extra?.streaming === true, "must be marked as streaming")

    // All deltas must share the same messageId
    const ids = new Set(deltas.map((d) => d.messageId))
    assert.equal(ids.size, 1, "all deltas must share the same messageId")
    assert.equal(ids.has(result.id), true, "delta messageId must match result id")

    // Content deltas should have been called
    assert.ok(deltas.length >= 2, "expected at least 2 content deltas")
    // First delta may include "Hello" (with the role delta), second " world", third "!"
    const fullDelta = deltas.map((d) => d.delta).join("")
    assert.equal(fullDelta, "Hello world!")
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  14. Streaming: tool_calls accumulation                             */
/* ------------------------------------------------------------------ */

test("streaming query accumulates tool_call deltas", async () => {
  // Build SSE data as an array of objects that we serialize ourselves
  // to avoid template-literal escaping issues
  const sseChunks: Array<Record<string, unknown>> = [
    { choices: [{ delta: { role: "assistant", content: "" }, index: 0 }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "shell_run", arguments: "" } }] }, index: 0 }] },
  ]
  // Second tool_call delta: partial arguments - opening brace + key
  sseChunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command": ' } }] }, index: 0 }] })
  // Third tool_call delta: rest of arguments - value + closing brace
  sseChunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] }, index: 0 }] })
  const sseBody = [
    ...sseChunks.map((c) => `data: ${JSON.stringify(c)}`),
    "data: [DONE]",
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeStreamingFetch(sseBody)
  try {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "run echo", createdAt: 0 }],
      tools: [
        {
          name: "shell.run",
          description: "Run shell command",
          inputSchema: {},
          permission: "shell",
        },
      ],
      callbacks: { onTextDelta() {} },
    })

    assert.equal(result.role, "assistant")
    assert.ok(result.actions, "must have actions")
    assert.equal(result.actions!.length, 1)

    const action = result.actions![0]
    assert.equal(action.tool, "shell.run")
    assert.equal(action.providerToolCallId, "call_abc")
    assert.deepEqual(action.args, { command: "echo hi" })
    assert.equal(action.source, "llm")
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  15. Streaming: network error returns errorMessage                  */
/* ------------------------------------------------------------------ */

test("streaming query: network error returns errorMessage without leaking key", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("fetch failed: ENOTFOUND")
  }
  try {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-super-secret",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
      callbacks: { onTextDelta() {} },
    })

    assert.equal(result.role, "assistant")
    assert.equal(typeof result.content, "string")
    assert.ok((result.content as string).includes("Network error"))
    assert.ok(!(result.content as string).includes("sk-super-secret"), "must not leak API key")
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  16. Streaming: HTTP error returns errorMessage                     */
/* ------------------------------------------------------------------ */

test("streaming query: HTTP 500 returns errorMessage without leaking key", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })
  }
  try {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-super-secret",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
      callbacks: { onTextDelta() {} },
    })

    assert.equal(result.role, "assistant")
    assert.equal(typeof result.content, "string")
    assert.ok((result.content as string).includes("500"))
    assert.ok(!(result.content as string).includes("sk-super-secret"), "must not leak API key")
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  17. Streaming: no body returns errorMessage                        */
/* ------------------------------------------------------------------ */

test("streaming query: response with no body returns errorMessage", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    return new Response(null, { status: 200 })
  }
  try {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
      callbacks: { onTextDelta() {} },
    })

    assert.equal(result.role, "assistant")
    assert.equal(typeof result.content, "string")
    assert.ok((result.content as string).includes("no body"))
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  18. Without callbacks, query still works (non-streaming)           */
/* ------------------------------------------------------------------ */

test("query without callbacks uses non-streaming path", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    // Verify that stream:true is NOT in the body
    const body = JSON.parse(init?.body as string)
    assert.equal(body.stream, undefined, "non-streaming path must not set stream:true")
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "non-streaming reply" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }
  try {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
    })

    assert.equal(result.content, "non-streaming reply")
    assert.equal(result.extra?.streaming, undefined, "must not be marked as streaming")
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  19. Streaming: stream:true is set in the request body              */
/* ------------------------------------------------------------------ */

test("streaming query sets stream:true in request body", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    assert.equal(body.stream, true, "streaming path must set stream:true")

    return new Response(sseStream(["data: [DONE]"]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  }
  try {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    })

    await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
      callbacks: { onTextDelta() {} },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ------------------------------------------------------------------ */
/*  20. Streaming: malformed SSE lines are skipped gracefully          */
/* ------------------------------------------------------------------ */

test("streaming query skips malformed SSE lines gracefully", async () => {
  const sseBody = [
    "data: {invalid json",
    'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}',
    "data: [DONE]",
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeStreamingFetch(sseBody)
  try {
    const deltas: string[] = []
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    })

    const result = await adapter.query({
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
      tools: [],
      callbacks: {
        onTextDelta(_id, delta) { deltas.push(delta) },
      },
    })

    assert.equal(result.content, "ok")
    assert.deepEqual(deltas, ["ok"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
