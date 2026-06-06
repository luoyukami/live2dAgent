/**
 * Tests for OpenAiCompatibleAdapter — audio attachment expansion,
 * audio-disabled fallback, and base64 redaction.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter.js"
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
/*  3. webm mime → format still "wav"                                  */
/* ------------------------------------------------------------------ */

test("webm mime type still produces format wav", () => {
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

  const body = adapter.buildRequestBodyForTest([message], [])
  const messages = body.messages as Array<{ role: string; content: unknown }>
  const userMsg = messages.find((m) => m.role === "user")!

  assert.ok(Array.isArray(userMsg.content))
  const parts = userMsg.content as Array<Record<string, unknown>>
  const audioPart = parts.find((p) => p.type === "input_audio") as {
    input_audio: { format: string }
  }
  assert.equal(audioPart.input_audio.format, "wav")
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
