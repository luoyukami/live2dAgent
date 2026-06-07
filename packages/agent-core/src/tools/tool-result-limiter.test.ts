/**
 * Tests for tool-result-limiter.ts — ToolResultLimiter.
 *
 * Covers:
 *   - Content within inline limit is returned as-is
 *   - Content exceeding inline limit is truncated with head/tail/omitted
 *   - With artifactWriter: full content is persisted, artifactRef in output
 *   - ArtifactWriter failure is non-fatal (falls back to truncated output)
 *   - Status field is propagated correctly (ok, error, denied)
 *   - Custom limits via constructor options
 *   - Empty content is handled correctly
 *   - JSON output is parseable and contains expected fields
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { ToolResultLimiter, type ArtifactWriter } from "./tool-result-limiter.js"

describe("ToolResultLimiter", () => {
  test("content within inline limit is returned as-is", async () => {
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 100,
      summaryCharLimit: 50,
      headChars: 30,
      tailChars: 30,
    })

    const result = await limiter.limit("test.tool", "Hello world", "ok")
    const parsed = JSON.parse(result.output)

    assert.equal(parsed.status, "ok")
    assert.equal(parsed.summary, "Hello world")
    assert.equal(parsed.content, "Hello world")
    assert.equal(result.fullLength, 11)
    assert.equal(result.artifactRef, undefined)
  })

  test("content exactly at inline limit is not truncated", async () => {
    const content = "x".repeat(100)
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 100,
    })

    const result = await limiter.limit("test.tool", content, "ok")
    const parsed = JSON.parse(result.output)

    assert.equal(parsed.content, content)
    assert.equal(result.artifactRef, undefined)
  })

  test("content exceeding inline limit is truncated with head/tail/omitted", async () => {
    // Create content: 50 A's + 50 B's + 50 C's = 150 chars
    const content = "A".repeat(50) + "B".repeat(50) + "C".repeat(50)

    const limiter = new ToolResultLimiter({
      inlineCharLimit: 20,
      summaryCharLimit: 10,
      headChars: 15,
      tailChars: 15,
    })

    const result = await limiter.limit("test.tool", content, "ok")
    const parsed = JSON.parse(result.output)

    assert.equal(parsed.status, "ok")
    // Summary should be first 10 chars
    assert.equal(parsed.summary, "A".repeat(10))
    // Content should contain head (15 A's)
    assert.ok(parsed.content.startsWith("A".repeat(15)))
    // Content should contain tail (15 C's)
    assert.ok(parsed.content.endsWith("C".repeat(15)))
    // Content should mention omitted chars
    assert.ok(parsed.content.includes("omitted"))
    // omitted = 150 - 15 - 15 = 120
    assert.ok(parsed.content.includes("120"))
    assert.equal(result.fullLength, 150)
    assert.equal(result.artifactRef, undefined)
  })

  test("with artifactWriter persists full content and includes artifactRef", async () => {
    let writtenName = ""
    let writtenContent = ""
    const writer: ArtifactWriter = {
      async writeArtifact(name: string, content: string) {
        writtenName = name
        writtenContent = content
        return { id: "art_output_001", path: "/tmp/art_output_001.txt", size: content.length }
      },
    }

    const content = "X".repeat(200)
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 50,
      summaryCharLimit: 20,
      headChars: 15,
      tailChars: 15,
      artifactWriter: writer,
    })

    const result = await limiter.limit("sample.tool", content, "ok")
    const parsed = JSON.parse(result.output)

    // ArtifactWriter should have been called
    assert.ok(writtenName.startsWith("tool_output_sample_tool"))
    assert.equal(writtenContent, content)

    // artifactRef should be present
    assert.equal(parsed.artifactRef, "artifact://tool-output/art_output_001")
    assert.equal(result.artifactRef, "artifact://tool-output/art_output_001")
    assert.equal(result.fullLength, 200)

    // Content should be truncated
    assert.ok(parsed.content.length < 100)
    assert.ok(parsed.content.includes("omitted"))
  })

  test("artifactWriter failure does not break limiting", async () => {
    const writer: ArtifactWriter = {
      async writeArtifact() {
        throw new Error("Disk full")
      },
    }

    const content = "Y".repeat(200)
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 50,
      summaryCharLimit: 20,
      headChars: 15,
      tailChars: 15,
      artifactWriter: writer,
    })

    const result = await limiter.limit("sample.tool", content, "ok")
    const parsed = JSON.parse(result.output)

    // Should still produce valid output without artifactRef
    assert.equal(result.artifactRef, undefined)
    assert.equal(parsed.artifactRef, undefined)
    assert.ok(parsed.content.includes("omitted"))
    assert.equal(parsed.status, "ok")
  })

  test("propagates error and denied status", async () => {
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 100,
    })

    const errorResult = await limiter.limit("test.tool", "Error content", "error")
    const errorParsed = JSON.parse(errorResult.output)
    assert.equal(errorParsed.status, "error")
    assert.equal(errorParsed.summary, "Error content")

    const deniedResult = await limiter.limit("test.tool", "Denied content", "denied")
    const deniedParsed = JSON.parse(deniedResult.output)
    assert.equal(deniedParsed.status, "denied")
    assert.equal(deniedParsed.summary, "Denied content")
  })

  test("uses default constants from WS_RUNTIME_CONSTANTS when no options provided", async () => {
    const limiter = new ToolResultLimiter()
    // No options = uses WS_RUNTIME_CONSTANTS defaults
    // Just verify it doesn't throw
    const result = await limiter.limit("test.tool", "Hello", "ok")
    const parsed = JSON.parse(result.output)
    assert.equal(parsed.status, "ok")
  })

  test("empty content is returned as-is", async () => {
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 100,
    })

    const result = await limiter.limit("test.tool", "", "ok")
    const parsed = JSON.parse(result.output)

    assert.equal(parsed.status, "ok")
    assert.equal(parsed.summary, "")
    assert.equal(parsed.content, "")
    assert.equal(result.fullLength, 0)
  })

  test("JSON output is always parseable with expected fields", async () => {
    const limiter = new ToolResultLimiter({
      inlineCharLimit: 10,
      summaryCharLimit: 5,
      headChars: 3,
      tailChars: 3,
    })

    const result = await limiter.limit("test.tool", "Long content here that exceeds limit", "ok")
    const parsed = JSON.parse(result.output)

    // Must have all required fields
    assert.ok("status" in parsed)
    assert.ok("summary" in parsed)
    assert.ok("content" in parsed)

    // status is correct string
    assert.equal(parsed.status, "ok")

    // summary is string
    assert.equal(typeof parsed.summary, "string")

    // content is string
    assert.equal(typeof parsed.content, "string")
  })
})
