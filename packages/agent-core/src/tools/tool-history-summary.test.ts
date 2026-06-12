/**
 * buildToolHistorySummary / isToolHistorySummary unit tests.
 *
 * Verifies:
 *   1. Output is a short [Tool Result Summary] block.
 *   2. Prefers JSON output's summary / artifactRef over raw output.
 *   3. Falls back to input.summary, then parsed summary/content, then output.
 *   4. isToolHistorySummary detects the marker reliably.
 *   5. maxChars clamp works.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { buildToolHistorySummary, isToolHistorySummary } from "./tool-history-summary.js"

/* ------------------------------------------------------------------ */
/*  isToolHistorySummary                                               */
/* ------------------------------------------------------------------ */

describe("isToolHistorySummary", () => {
  test("returns true for [Tool Result Summary] prefix", () => {
    assert.equal(isToolHistorySummary("[Tool Result Summary]\nTool: shell.run"), true)
  })

  test("returns false for other content", () => {
    assert.equal(isToolHistorySummary("stdout: hello"), false)
    assert.equal(isToolHistorySummary(""), false)
  })
})

/* ------------------------------------------------------------------ */
/*  buildToolHistorySummary — basic                                     */
/* ------------------------------------------------------------------ */

describe("buildToolHistorySummary — basic", () => {
  test("starts with [Tool Result Summary] and includes tool name + status", () => {
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "ok",
      output: "hello world",
    })
    assert.ok(result.startsWith("[Tool Result Summary]"))
    assert.ok(result.includes("Tool: shell.run"))
    assert.ok(result.includes("Status: ok"))
    assert.ok(result.includes("Summary:"))
    assert.ok(result.includes("Full output omitted from future context."))
  })

  test("output is short (< maxChars default 800)", () => {
    const result = buildToolHistorySummary({
      toolName: "file.read",
      status: "ok",
      output: "x".repeat(5000),
    })
    assert.ok(result.length <= 800, `Expected <=800 chars, got ${result.length}`)
  })

  test("includes Artifact line when artifactRef is provided via input", () => {
    const result = buildToolHistorySummary({
      toolName: "screenshot.capture",
      status: "ok",
      artifactRef: "artifact://screenshots/ss_001.png",
      output: "Screenshot saved",
    })
    assert.ok(result.includes("Artifact: artifact://screenshots/ss_001.png"))
  })
})

/* ------------------------------------------------------------------ */
/*  buildToolHistorySummary — JSON output parsing                       */
/* ------------------------------------------------------------------ */

describe("buildToolHistorySummary — JSON output parsing", () => {
  test("prefers JSON output's summary field over raw output", () => {
    const jsonOutput = JSON.stringify({
      summary: "Copied 3 files to destination",
      content: "file1.txt, file2.txt, file3.txt",
    })
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "ok",
      output: jsonOutput,
    })
    assert.ok(result.includes("Copied 3 files to destination"),
      "Should use parsed JSON summary, not raw JSON string")
    // Must NOT contain the raw JSON
    assert.ok(!result.includes('"summary"'), "Must not contain raw JSON")
  })

  test("prefers JSON output's artifactRef over missing input artifactRef", () => {
    const jsonOutput = JSON.stringify({
      summary: "Screenshot taken",
      artifactRef: "artifact://screenshots/auto_002.png",
    })
    const result = buildToolHistorySummary({
      toolName: "screenshot.capture",
      status: "ok",
      output: jsonOutput,
    })
    assert.ok(result.includes("Artifact: artifact://screenshots/auto_002.png"),
      "Should extract artifactRef from JSON output")
  })

  test("input artifactRef overrides JSON artifactRef", () => {
    const jsonOutput = JSON.stringify({
      summary: "Done",
      artifactRef: "artifact://screenshots/old.png",
    })
    const result = buildToolHistorySummary({
      toolName: "screenshot.capture",
      status: "ok",
      artifactRef: "artifact://screenshots/preferred.png",
      output: jsonOutput,
    })
    assert.ok(result.includes("Artifact: artifact://screenshots/preferred.png"),
      "Input artifactRef should take precedence")
    assert.ok(!result.includes("old.png"), "JSON artifactRef should be overridden")
  })

  test("JSON content field used when summary is absent", () => {
    const jsonOutput = JSON.stringify({ content: "File content goes here" })
    const result = buildToolHistorySummary({
      toolName: "file.read",
      status: "ok",
      output: jsonOutput,
    })
    assert.ok(result.includes("File content goes here"))
  })

  test("falls back to raw output when JSON has no summary/content", () => {
    const jsonOutput = JSON.stringify({ unrelated: 42 })
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "ok",
      output: jsonOutput,
    })
    // Should fall back to the raw output string (which is the JSON)
    assert.ok(result.includes("Summary:"))
  })

  test("non-JSON output uses raw output as summary source", () => {
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "error",
      output: "command not found: xyz",
    })
    assert.ok(result.includes("command not found: xyz"))
  })
})

/* ------------------------------------------------------------------ */
/*  buildToolHistorySummary — input.summary priority                    */
/* ------------------------------------------------------------------ */

describe("buildToolHistorySummary — summary priority", () => {
  test("input.summary takes precedence over JSON summary", () => {
    const jsonOutput = JSON.stringify({ summary: "JSON summary" })
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "ok",
      summary: "Input summary",
      output: jsonOutput,
    })
    assert.ok(result.includes("Input summary"), "input.summary should win")
    assert.ok(!result.includes("JSON summary"), "JSON summary should be overshadowed")
  })

  test("JSON summary used when input.summary is empty", () => {
    const jsonOutput = JSON.stringify({ summary: "From JSON" })
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "ok",
      summary: "",
      output: jsonOutput,
    })
    assert.ok(result.includes("From JSON"))
  })
})

/* ------------------------------------------------------------------ */
/*  buildToolHistorySummary — clamp                                     */
/* ------------------------------------------------------------------ */

describe("buildToolHistorySummary — maxChars clamp", () => {
  test("respects custom maxChars", () => {
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "ok",
      output: "a".repeat(2000),
      maxChars: 120,
    })
    assert.ok(result.length <= 120, `Expected <=120 chars, got ${result.length}`)
    assert.ok(result.includes("..."), "Clamped text should end with ellipsis")
  })

  test("status from JSON output used when input.status is empty", () => {
    const jsonOutput = JSON.stringify({ status: "error", summary: "failed" })
    const result = buildToolHistorySummary({
      toolName: "shell.run",
      status: "",
      output: jsonOutput,
    })
    assert.ok(result.includes("Status: error"))
  })
})
