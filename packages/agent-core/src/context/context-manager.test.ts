/**
 * ContextManager unit tests.
 *
 * Tests:
 *   1. ContextManager.build() — normal case (within soft limit)
 *   2. Recent 16 message window
 *   3. Soft limit — drops to last 8 messages
 *   4. Hard limit — returns context_hard_limit_exceeded error
 *   5. Artifact TTL — raw images expire after 1 turn
 *   6. Artifact TTL — raw audio expires after 1 turn
 *   7. 12MB raw artifact limit — only latest raw kept
 *   8. DefaultContextManager pass-through
 *   9. Tool results included in output
 *   10. Conversation summary included
 *   11. Token estimation accuracy
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { ContextManager, DefaultContextManager } from "./context-manager.js"
import type { ContextManagerInput, ArtifactEntry } from "./context-types.js"

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeMessages(count: number, role: "user" | "assistant" = "user"): ContextManagerInput["conversationMessages"] {
  const messages: ContextManagerInput["conversationMessages"] = []
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `msg_${i}`,
      role,
      content: `Message number ${i}. `.repeat(10), // ~150 chars each
      createdAt: Date.now() - (count - i) * 1000,
    })
  }
  return messages
}

function makeArtifact(
  overrides: Partial<ArtifactEntry> & { type: ArtifactEntry["type"] },
): ArtifactEntry {
  return {
    id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    rawData: "base64data_placeholder_" + "x".repeat(100),
    reference: "Test artifact",
    createdAt: Date.now(),
    turnIndex: 0,
    size: 1000,
    mimeType: overrides.type === "image" ? "image/png" : "audio/wav",
    ...overrides,
  }
}

function makeInput(overrides: Partial<ContextManagerInput> = {}): ContextManagerInput {
  return {
    systemInstructions: "You are a helpful assistant.",
    currentUserMessage: "Hello, can you help me?",
    conversationMessages: makeMessages(20),
    toolResults: [],
    conversationSummary: undefined,
    currentArtifacts: [],
    historicalArtifacts: [],
    toolSchemas: [],
    currentTurnIndex: 5,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/*  Tests — normal case                                                */
/* ------------------------------------------------------------------ */

describe("ContextManager — normal case", () => {
  test("build returns messages within soft limit", () => {
    const cm = new ContextManager()
    const input = makeInput()
    const result = cm.build(input)

    assert.equal(result.error, undefined, "Should not have error")
    assert.equal(result.truncated, false, "Should not be truncated")
    assert.ok(result.tokenEstimate > 0, "Should have token estimate")
    assert.ok(result.messages.length > 0, "Should have messages")

    // Should include system instructions
    const systemMsg = result.messages.find((m) => m.role === "system")
    assert.ok(systemMsg, "Should include system instructions")
    assert.ok(systemMsg!.content.includes("helpful assistant"))

    // Should include current user message
    const userMsgs = result.messages.filter((m) => m.role === "user")
    const hasCurrentMsg = userMsgs.some((m) => m.content.includes("Hello"))
    assert.ok(hasCurrentMsg, "Should include current user message")
  })

  test("includes up to 16 recent text messages", () => {
    const cm = new ContextManager({ softTokenLimit: 1_000_000, hardTokenLimit: 2_000_000 })
    const input = makeInput({ conversationMessages: makeMessages(30) })
    const result = cm.build(input)

    // Should only include the last 16 (default maxRecentTextMessages)
    const conversationUserMsgs = result.messages.filter(
      (m) => m.role === "user" && m.content.includes("Message number"),
    )
    assert.ok(
      conversationUserMsgs.length <= 16,
      `Should have at most 16 recent messages, got ${conversationUserMsgs.length}`,
    )

    // The oldest message should not be included (it's from the first 14 of 30)
    // The last 16 of 30 are messages 14-29 (0-indexed), so message 14 should be the earliest
    const hasMsg0 = conversationUserMsgs.some((m) => m.content.includes("Message number 0"))
    assert.equal(hasMsg0, false, "Message 0 should be dropped (beyond last 16)")
  })

  test("tool results are included in messages", () => {
    const cm = new ContextManager({ softTokenLimit: 1_000_000 })
    const input = makeInput({
      toolResults: [
        { toolCallId: "call_1", toolName: "shell.run", status: "ok", summary: "Success", contentForModel: "Command output: hello world" },
        { toolCallId: "call_2", toolName: "file.read", status: "ok", summary: "Read file", contentForModel: "File contents: some data" },
      ],
    })
    const result = cm.build(input)

    const toolMsgs = result.messages.filter((m) => m.role === "tool")
    assert.equal(toolMsgs.length, 2, "Should include 2 tool result messages")
    assert.ok(toolMsgs[0]!.content.includes("hello world"), "First tool result content preserved")
  })

  test("conversation summary is included", () => {
    const cm = new ContextManager()
    const input = makeInput({ conversationSummary: "The user asked about JavaScript and received code examples." })
    const result = cm.build(input)

    const summaryMsgs = result.messages.filter(
      (m) => m.role === "system" && m.content.includes("Conversation Summary"),
    )
    assert.equal(summaryMsgs.length, 1, "Should include summary as system message")
    assert.ok(summaryMsgs[0]!.content.includes("JavaScript"))
  })
})

/* ------------------------------------------------------------------ */
/*  Tests — token budget                                               */
/* ------------------------------------------------------------------ */

describe("ContextManager — token budget", () => {
  test("within soft limit (48k): all messages included, not truncated", () => {
    const cm = new ContextManager({ softTokenLimit: 48_000, hardTokenLimit: 64_000, reservedOutputTokens: 0 })
    // Small messages should easily fit
    const input = makeInput({
      conversationMessages: makeMessages(5),
      currentUserMessage: "Short query",
    })
    const result = cm.build(input)

    assert.equal(result.error, undefined)
    assert.equal(result.truncated, false)
    assert.ok(result.tokenEstimate <= 48_000)
  })

  test("soft limit exceeded (48k-64k): drops older messages, keeps last 8", () => {
    const cm = new ContextManager({
      softTokenLimit: 500,  // Very low to force soft limit
      hardTokenLimit: 100_000,
      reservedOutputTokens: 0,
      maxRecentTextMessages: 16,
      maxRecentMessagesOnSoftLimit: 8,
    })
    // Generate enough messages to exceed soft limit
    const manyLongMsgs = makeMessages(20).map((m) => ({
      ...m,
      content: "This is a very long message that will consume tokens quickly. ".repeat(50),
    }))
    const input = makeInput({
      conversationMessages: manyLongMsgs,
    })
    const result = cm.build(input)

    // Should be truncated
    assert.equal(result.truncated, true, "Should be marked as truncated")

    // Should have at most 8 recent messages (user messages from conversation)
    // Plus system, current user, etc.
    const convUserMsgs = result.messages.filter(
      (m) => m.role === "user" && m.content.includes("This is a very long message"),
    )
    assert.ok(
      convUserMsgs.length <= 8,
      `Should have at most 8 recent messages under soft limit, got ${convUserMsgs.length}`,
    )
  })

  test("soft limit exceeded: summary and current user message preserved", () => {
    const cm = new ContextManager({
      softTokenLimit: 500,
      hardTokenLimit: 100_000,
      reservedOutputTokens: 0,
      maxRecentTextMessages: 16,
      maxRecentMessagesOnSoftLimit: 8,
    })
    const manyLongMsgs = makeMessages(20).map((m) => ({
      ...m,
      content: "Long message content that takes many tokens. ".repeat(50),
    }))
    const input = makeInput({
      conversationMessages: manyLongMsgs,
      conversationSummary: "Key discussion summary here.",
      currentUserMessage: "My current query is important.",
    })
    const result = cm.build(input)

    // Summary should be present
    const summaryMsgs = result.messages.filter(
      (m) => m.role === "system" && m.content.includes("Summary"),
    )
    assert.ok(summaryMsgs.length >= 1, "Summary should be preserved")

    // Current user message should be present
    const hasCurrentMsg = result.messages.some(
      (m) => m.role === "user" && m.content.includes("My current query"),
    )
    assert.ok(hasCurrentMsg, "Current user message should be preserved")
  })

  test("hard limit exceeded (>64k): returns context_hard_limit_exceeded error", () => {
    const cm = new ContextManager({
      softTokenLimit: 500,
      hardTokenLimit: 600,  // Very tight
      reservedOutputTokens: 0,
    })
    // Generate massive messages to exceed hard limit
    const hugeMsgs = makeMessages(3).map((m) => ({
      ...m,
      content: "X".repeat(10_000), // ~2857 tokens each * 3 = ~8571 tokens >> 600
    }))
    const input = makeInput({
      conversationMessages: hugeMsgs,
    })
    const result = cm.build(input)

    assert.ok(result.error !== undefined, "Should have error")
    assert.equal(result.error!.code, "context_hard_limit_exceeded")
    assert.equal(result.error!.retryable, false)
  })

  test("effective limits subtract reserved output tokens", () => {
    const cm = new ContextManager({
      softTokenLimit: 48_000,
      hardTokenLimit: 64_000,
      reservedOutputTokens: 8_000,
    })
    // With 8000 reserved, effective soft is 40000, effective hard is 56000
    // Create input that is between 40000 and 48000 tokens
    const manyLongMsgs = makeMessages(10).map((m) => ({
      ...m,
      content: "Medium length content to test effective limits. ".repeat(200),
    }))
    const input = makeInput({
      conversationMessages: manyLongMsgs,
    })
    const result = cm.build(input)

    // Either normal or truncated depending on exact token count
    // The key is that we don't get a hard limit error (which would happen
    // with a 56000 effective hard limit if we had 64000+ raw tokens)
    assert.equal(result.error, undefined, "Should not exceed effective hard limit")
  })
})

/* ------------------------------------------------------------------ */
/*  Tests — artifact TTL                                               */
/* ------------------------------------------------------------------ */

describe("ContextManager — artifact TTL", () => {
  test("raw image within TTL is included as raw", () => {
    const cm = new ContextManager({ rawImageTtlTurns: 1 })
    const input = makeInput({
      currentArtifacts: [makeArtifact({ type: "image", turnIndex: 5, reference: "Screenshot" })],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    const includedImages = result.includedArtifacts.filter((a) => a.type === "image")
    assert.equal(includedImages.length, 1, "Image should be included as raw")
    assert.ok(includedImages[0]!.rawData, "Raw data should be present")
  })

  test("raw image exceeded TTL becomes reference-only", () => {
    const cm = new ContextManager({ rawImageTtlTurns: 1 })
    const input = makeInput({
      historicalArtifacts: [makeArtifact({ type: "image", turnIndex: 3, reference: "Old screenshot", rawData: "old_base64_data" })],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    // The image from turn 3 is now 2 turns ago (currentTurnIndex 5 - turnIndex 3 = 2 > 1 TTL)
    const referencedImages = result.referencedArtifacts.filter((a) => a.type === "image")
    assert.ok(referencedImages.length >= 1, "Image should be referenced (not raw) after TTL expiry")
    assert.equal(referencedImages[0]!.rawData, undefined, "Raw data should be absent in reference")
  })

  test("raw audio exceeded TTL becomes reference-only", () => {
    const cm = new ContextManager({ rawAudioTtlTurns: 1 })
    const input = makeInput({
      historicalArtifacts: [makeArtifact({ type: "audio", turnIndex: 2, reference: "Old recording" })],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    // Audio from turn 2 is 3 turns ago > 1 TTL
    const refAudio = result.referencedArtifacts.filter((a) => a.type === "audio")
    assert.ok(refAudio.length >= 1, "Audio should be referenced after TTL")
  })

  test("raw audio within TTL is included", () => {
    const cm = new ContextManager({ rawAudioTtlTurns: 1 })
    const input = makeInput({
      currentArtifacts: [makeArtifact({ type: "audio", turnIndex: 5, reference: "Voice memo" })],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    const includedAudio = result.includedArtifacts.filter((a) => a.type === "audio")
    assert.equal(includedAudio.length, 1, "Audio should be included as raw")
  })

  test("current turn artifacts are always included (TTL=1, same turn)", () => {
    const cm = new ContextManager({ rawImageTtlTurns: 1, rawAudioTtlTurns: 1 })
    const input = makeInput({
      currentArtifacts: [
        makeArtifact({ type: "image", turnIndex: 5, reference: "Current screenshot" }),
        makeArtifact({ type: "audio", turnIndex: 5, reference: "Current recording" }),
      ],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    assert.equal(result.includedArtifacts.length, 2, "Both current-turn artifacts should be raw-included")
  })
})

/* ------------------------------------------------------------------ */
/*  Tests — 12MB raw artifact limit                                    */
/* ------------------------------------------------------------------ */

describe("ContextManager — raw artifact size limit (12MB)", () => {
  test("all raw artifacts fit within 12MB — all included", () => {
    const cm = new ContextManager({ maxRawArtifactBytes: 12 * 1024 * 1024 })
    const input = makeInput({
      currentArtifacts: [
        makeArtifact({ type: "image", size: 2 * 1024 * 1024, reference: "Image 1", turnIndex: 5 }),   // 2MB
        makeArtifact({ type: "audio", size: 3 * 1024 * 1024, reference: "Audio 1", turnIndex: 5 }),    // 3MB
      ],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    assert.equal(result.includedArtifacts.length, 2, "Both artifacts should be included")
    assert.equal(result.referencedArtifacts.length, 0, "No artifacts should be referenced-only")
  })

  test("raw artifacts exceed 12MB — only latest raw kept, rest referenced", () => {
    const cm = new ContextManager({ maxRawArtifactBytes: 12 * 1024 * 1024 })
    const input = makeInput({
      currentArtifacts: [
        makeArtifact({ type: "image", size: 8 * 1024 * 1024, reference: "Big image", turnIndex: 5 }),
        makeArtifact({ type: "audio", size: 7 * 1024 * 1024, reference: "Big audio", turnIndex: 5 }),
      ],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    // Total = 15MB > 12MB, so only one should be raw
    assert.equal(result.includedArtifacts.length, 1, "Only one artifact should be raw-included")
    // The largest or most recent should be the one included
    assert.ok(result.referencedArtifacts.length >= 1, "The other should be referenced-only")
    // Both should be accounted for in total
    assert.equal(
      result.includedArtifacts.length + result.referencedArtifacts.length,
      2,
      "All artifacts accounted for",
    )
  })

  test("multiple artifacts just under 12MB — all included", () => {
    const cm = new ContextManager({ maxRawArtifactBytes: 12 * 1024 * 1024 })
    const input = makeInput({
      currentArtifacts: [
        makeArtifact({ type: "image", size: 4 * 1024 * 1024, reference: "Image A", turnIndex: 5 }),
        makeArtifact({ type: "audio", size: 4 * 1024 * 1024, reference: "Audio B", turnIndex: 5 }),
        makeArtifact({ type: "image", size: 4 * 1024 * 1024, reference: "Image C", turnIndex: 5 }),
      ],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    // 4+4+4 = 12MB, exactly at limit
    assert.equal(result.includedArtifacts.length, 3, "All artifacts should fit within 12MB")
    assert.equal(result.referencedArtifacts.length, 0, "No references needed")
  })

  test("single artifact over 12MB — still included (individual items not split)", () => {
    const cm = new ContextManager({ maxRawArtifactBytes: 12 * 1024 * 1024 })
    const input = makeInput({
      currentArtifacts: [
        makeArtifact({ type: "image", size: 15 * 1024 * 1024, reference: "Huge image", turnIndex: 5 }),
      ],
      currentTurnIndex: 5,
    })
    const result = cm.build(input)

    // A single artifact that's over 12MB should still be raw-included
    // (the constraint is about total raw bytes, and with only one item
    // it's the "latest" by default)
    assert.equal(result.includedArtifacts.length, 1, "Single artifact should be included even if over 12MB")
  })
})

/* ------------------------------------------------------------------ */
/*  Tests — DefaultContextManager                                       */
/* ------------------------------------------------------------------ */

describe("DefaultContextManager — pass-through", () => {
  test("build returns all messages without truncation", () => {
    const cm = new DefaultContextManager()
    const input = makeInput({
      conversationMessages: makeMessages(50), // More than 16
      toolResults: [
        { toolCallId: "call_1", toolName: "test", status: "ok", summary: "OK", contentForModel: "Result data" },
      ],
      conversationSummary: "Test summary",
    })
    const result = cm.build(input)

    assert.equal(result.error, undefined)
    assert.equal(result.truncated, false, "DefaultContextManager should never truncate")

    // Should have system + summary + all 50 messages + current user + tool result
    const sysMsgs = result.messages.filter((m) => m.role === "system")
    assert.equal(sysMsgs.length, 2, "Should have system instructions and summary")

    // Should include many messages (not limited to 16)
    const userMsgs = result.messages.filter((m) => m.role === "user")
    assert.ok(userMsgs.length > 16, "Should include more than 16 user messages (no limit)")

    // Tool results included
    const toolMsgs = result.messages.filter((m) => m.role === "tool")
    assert.equal(toolMsgs.length, 1)
  })
})

/* ------------------------------------------------------------------ */
/*  Tests — RunController integration (ContextManager output)          */
/* ------------------------------------------------------------------ */

describe("ContextManager — RunController integration patterns", () => {
  test("build output can be used as ModelWsCreateResponseInput messages", () => {
    const cm = new ContextManager()
    const input = makeInput({
      conversationMessages: makeMessages(3),
      currentUserMessage: "Run a shell command",
      toolResults: [
        { toolCallId: "call_1", toolName: "shell.run", status: "ok", summary: "Success", contentForModel: "output text" },
      ],
    })
    const result = cm.build(input)

    assert.equal(result.error, undefined)

    // The messages array is compatible with ModelWsCreateResponseInput
    for (const msg of result.messages) {
      assert.ok(["system", "user", "assistant", "tool"].includes(msg.role))
      assert.equal(typeof msg.content, "string")
    }

    // Should have system + 3 conv msgs + current user + tool result
    assert.ok(result.messages.length >= 5)

    // Tool result with contentForModel should not contain full long output
    const toolMsg = result.messages.find((m) => m.role === "tool")
    assert.ok(toolMsg)
    assert.equal(toolMsg!.content, "output text")
  })
})

/* ------------------------------------------------------------------ */
/*  Tests — long tool output not in model input                        */
/* ------------------------------------------------------------------ */

describe("ContextManager — long tool output isolation", () => {
  test("tool result contentForModel is used directly, not full output", () => {
    const cm = new ContextManager()
    const longContent = "A".repeat(100_000) // 100k chars
    const input = makeInput({
      toolResults: [
        {
          toolCallId: "call_1",
          toolName: "shell.run",
          status: "ok",
          summary: "Truncated output",
          contentForModel: longContent.slice(0, 8_000), // Already truncated by ToolOutputTruncator
        },
      ],
    })
    const result = cm.build(input)

    const toolMsg = result.messages.find((m) => m.role === "tool")
    assert.ok(toolMsg)
    // The full 100k should NOT be in the message
    assert.ok(toolMsg!.content.length <= 8_000, "Tool message should use truncated content")
    assert.equal(toolMsg!.content, longContent.slice(0, 8_000))
  })
})
