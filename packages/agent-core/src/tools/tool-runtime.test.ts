/**
 * Tool Runtime unit tests.
 *
 * Tests:
 *   - ToolCallValidator: valid / invalid args, missing required, wrong types, unknown tool
 *   - ToolOutputTruncator: inline fits, inline exceeded, with artifactWriter, denied/invalid results
 *   - processToolCalls: full pipeline with approval, permission denied, invalid args, execution errors
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../tool-registry.js"
import {
  ToolCallValidator,
  ToolOutputTruncator,
  processToolCalls,
  type ArtifactWriter,
} from "./tool-runtime.js"
import type { WsToolCall, WsToolResult } from "../ws/ws-types.js"

/* ------------------------------------------------------------------ */
/*  Helper: sample tool definitions                                    */
/* ------------------------------------------------------------------ */

function createSampleRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(
    {
      name: "shell.run",
      description: "Run a shell command",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
      },
      permission: "shell",
    },
    {
      name: "file.read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      permission: "workspace_read",
    },
    {
      name: "no.schema",
      description: "Tool with no input schema",
      inputSchema: {},
      permission: "safe",
    },
    {
      name: "file.write",
      description: "Write a file",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string" },
          count: { type: "number" },
          enabled: { type: "boolean" },
          tags: { type: "array" },
          options: { type: "object" },
        },
      },
      permission: "workspace_write",
    },
  )
  return registry
}

/* ------------------------------------------------------------------ */
/*  ToolCallValidator tests                                            */
/* ------------------------------------------------------------------ */

describe("ToolCallValidator", () => {
  const validator = new ToolCallValidator()
  const registry = createSampleRegistry()

  test("valid arguments pass validation", () => {
    const result = validator.validate("shell.run", { command: "ls -la" }, registry)
    assert.equal(result.valid, true)
    assert.equal(result.error, undefined)
  })

  test("valid arguments with all optional fields", () => {
    const result = validator.validate("file.write", {
      path: "/tmp/test.txt",
      content: "hello",
      mode: "overwrite",
      count: 42,
      enabled: true,
      tags: ["a", "b"],
      options: { encoding: "utf8" },
    }, registry)
    assert.equal(result.valid, true)
  })

  test("missing required argument fails validation", () => {
    const result = validator.validate("shell.run", { cwd: "/tmp" }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /Missing required argument "command"/)
  })

  test("missing multiple required arguments", () => {
    const result = validator.validate("file.write", { path: "/tmp/test.txt" }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /Missing required argument "content"/)
  })

  test("unknown tool fails validation", () => {
    const result = validator.validate("nonexistent.tool", {}, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /Unknown tool/)
  })

  test("arguments must be a plain object when schema requires object", () => {
    const result = validator.validate("shell.run", "not-an-object", registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /must be a plain object/)
  })

  test("null arguments fails validation", () => {
    const result = validator.validate("shell.run", null, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /must be a plain object/)
  })

  test("wrong type for string argument", () => {
    const result = validator.validate("shell.run", { command: 42 }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /expected string/)
  })

  test("wrong type for number argument", () => {
    const result = validator.validate("file.write", { path: "/tmp/t", content: "hi", count: "not-a-number" }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /expected number/)
  })

  test("wrong type for boolean argument", () => {
    const result = validator.validate("file.write", { path: "/tmp/t", content: "hi", enabled: "yes" }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /expected boolean/)
  })

  test("wrong type for array argument", () => {
    const result = validator.validate("file.write", { path: "/tmp/t", content: "hi", tags: "not-an-array" }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /expected array/)
  })

  test("wrong type for object argument", () => {
    const result = validator.validate("file.write", { path: "/tmp/t", content: "hi", options: "not-an-object" }, registry)
    assert.equal(result.valid, false)
    assert.match(result.error ?? "", /expected object/)
  })

  test("tool with no schema always passes", () => {
    const result = validator.validate("no.schema", { anything: "goes" }, registry)
    assert.equal(result.valid, true)
  })

  test("tool with empty inputSchema passes", () => {
    const result = validator.validate("no.schema", 42, registry)
    assert.equal(result.valid, true)
  })

  test("extra properties on args do not cause failure", () => {
    const result = validator.validate("shell.run", { command: "ls", extraField: "ignored" }, registry)
    assert.equal(result.valid, true)
  })
})

/* ------------------------------------------------------------------ */
/*  ToolOutputTruncator tests                                          */
/* ------------------------------------------------------------------ */

describe("ToolOutputTruncator", () => {
  test("content within inline limit is returned as-is", async () => {
    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 100,
      summaryCharLimit: 50,
    })
    const result = await truncator.truncate("test.tool", "Hello world")
    assert.equal(result.summary, "Hello world")
    assert.equal(result.contentForModel, "Hello world")
    assert.equal(result.fullLength, 11)
    assert.equal(result.artifactRef, undefined)
  })

  test("content exactly at inline limit is returned as-is", async () => {
    const content = "x".repeat(100)
    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 100,
      summaryCharLimit: 50,
    })
    const result = await truncator.truncate("test.tool", content)
    assert.equal(result.contentForModel.length, 100)
    assert.equal(result.artifactRef, undefined)
  })

  test("content exceeding inline limit is truncated with head/tail", async () => {
    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 20,
      summaryCharLimit: 10,
    })
    // Create content of 100 chars
    const content = "A".repeat(50) + "B".repeat(50)
    const result = await truncator.truncate("test.tool", content)
    // Head should be first 10 chars (half of 20)
    assert.ok(result.contentForModel.startsWith("A".repeat(10)))
    // Tail should be last 10 chars
    assert.ok(result.contentForModel.endsWith("B".repeat(10)))
    // Should contain truncation message
    assert.ok(result.contentForModel.includes("truncated"))
    assert.equal(result.fullLength, 100)
    // Summary should be first 10 chars
    assert.equal(result.summary.length, 10)
    assert.equal(result.artifactRef, undefined)
  })

  test("content exceeding inline limit with artifactWriter creates artifactRef", async () => {
    let writtenName = ""
    let writtenContent = ""
    const writer: ArtifactWriter = {
      async writeArtifact(name: string, content: string) {
        writtenName = name
        writtenContent = content
        return { id: "art_123", path: "/tmp/art_123.txt", size: content.length }
      },
    }

    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 20,
      summaryCharLimit: 10,
      artifactWriter: writer,
    })

    const content = "X".repeat(100)
    const result = await truncator.truncate("sample.tool", content)
    assert.equal(writtenName, "tool_output_sample_tool")
    assert.equal(writtenContent, content)
    assert.equal(result.artifactRef, "art_123")
  })

  test("artifactWriter failure does not break truncation", async () => {
    const writer: ArtifactWriter = {
      async writeArtifact() {
        throw new Error("Disk full")
      },
    }

    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 20,
      summaryCharLimit: 10,
      artifactWriter: writer,
    })

    const content = "X".repeat(100)
    const result = await truncator.truncate("sample.tool", content)
    assert.equal(result.artifactRef, undefined) // Graceful fallback
    assert.ok(result.contentForModel.includes("truncated"))
  })

  test("deniedResult builds correct WsToolResult", () => {
    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 100,
      summaryCharLimit: 50,
    })
    const result = truncator.deniedResult("call_1", "shell.run", "User denied")
    assert.equal(result.toolCallId, "call_1")
    assert.equal(result.status, "denied")
    assert.equal(result.summary, 'Permission denied for shell.run: User denied')
    assert.equal(result.contentForModel, 'Tool shell.run was denied: User denied')
  })

  test("invalidArgumentsResult builds correct WsToolResult", () => {
    const truncator = new ToolOutputTruncator({
      inlineCharLimit: 100,
      summaryCharLimit: 50,
    })
    const result = truncator.invalidArgumentsResult("call_2", "file.read", 'Missing required "path"')
    assert.equal(result.toolCallId, "call_2")
    assert.equal(result.status, "error")
    assert.equal(result.summary, 'Invalid arguments for file.read: Missing required "path"')
    assert.ok(result.contentForModel.includes('was called with invalid arguments'))
  })
})

/* ------------------------------------------------------------------ */
/*  processToolCalls integration tests                                 */
/* ------------------------------------------------------------------ */

describe("processToolCalls", () => {
  const registry = createSampleRegistry()

  function makeToolCall(overrides: Partial<WsToolCall> = {}): WsToolCall {
    return {
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name: "shell.run",
      arguments: { command: "echo hello" },
      ...overrides,
    }
  }

  test("single valid tool call is executed and returns ok result", async () => {
    const call = makeToolCall()
    const results = await processToolCalls({
      toolCalls: [call],
      toolRegistry: registry,
      runtime: {
        async executeMany(inputs) {
          return inputs.map((i) => ({ id: i.id, ok: true, content: "hello from shell" }))
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
    })

    assert.equal(results.length, 1)
    assert.equal(results[0]!.toolCallId, call.id)
    assert.equal(results[0]!.result.status, "ok")
    assert.equal(results[0]!.result.summary, "hello from shell")
    assert.equal(results[0]!.result.contentForModel, "hello from shell")
  })

  test("multiple valid tool calls are all executed", async () => {
    const calls = [makeToolCall({ id: "call_1" }), makeToolCall({ id: "call_2" })]
    const results = await processToolCalls({
      toolCalls: calls,
      toolRegistry: registry,
      runtime: {
        async executeMany(inputs) {
          return inputs.map((i) => ({ id: i.id, ok: true, content: `result_${i.id}` }))
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
    })

    assert.equal(results.length, 2)
    assert.equal(results[0]!.result.contentForModel, "result_call_1")
    assert.equal(results[1]!.result.contentForModel, "result_call_2")
  })

  test("permission denied returns denied status with recoverable error", async () => {
    const call = makeToolCall()
    const results = await processToolCalls({
      toolCalls: [call],
      toolRegistry: registry,
      runtime: {
        async executeMany() {
          return [{ id: call.id, ok: true, content: "should not run" }]
        },
      },
      permission: {
        async check() {
          return {
            status: "denied",
            actions: [{ id: call.id, tool: "shell.run", args: { command: "echo hello" } }],
            reason: "User rejected this command",
          }
        },
      },
    })

    assert.equal(results.length, 1)
    assert.equal(results[0]!.result.status, "denied")
    assert.ok(results[0]!.result.summary.includes("User rejected"))
  })

  test("permission denied for one call, others execute", async () => {
    const call1 = makeToolCall({ id: "call_1", name: "shell.run", arguments: { command: "ls" } })
    const call2 = makeToolCall({ id: "call_2", name: "file.read", arguments: { path: "/tmp/test.txt" } })
    const call3 = makeToolCall({ id: "call_3", name: "shell.run", arguments: { command: "pwd" } })

    const results = await processToolCalls({
      toolCalls: [call1, call2, call3],
      toolRegistry: registry,
      runtime: {
        async executeMany(inputs) {
          return inputs.map((i) => ({ id: i.id, ok: true, content: `done_${i.id}` }))
        },
      },
      permission: {
        async check(actions) {
          // Deny call_1 and call_3, approve call_2
          return {
            status: "denied",
            actions: actions.filter((a) => a.id !== "call_2"),
            reason: "Some tools denied",
          }
        },
      },
    })

    assert.equal(results.length, 3)
    // call_1 denied
    assert.equal(results[0]!.result.status, "denied")
    // call_2 executed (ok)
    assert.equal(results[1]!.result.status, "ok")
    assert.equal(results[1]!.result.contentForModel, "done_call_2")
    // call_3 denied
    assert.equal(results[2]!.result.status, "denied")
  })

  test("invalid arguments return error status without execution", async () => {
    const call = makeToolCall({ arguments: {} }) // Missing required "command"
    let executed = false

    const results = await processToolCalls({
      toolCalls: [call],
      toolRegistry: registry,
      runtime: {
        async executeMany() {
          executed = true
          return [{ id: call.id, ok: true, content: "" }]
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
    })

    assert.equal(results.length, 1)
    assert.equal(results[0]!.result.status, "error")
    assert.ok(results[0]!.result.summary.includes("Invalid arguments"))
    // Tool should NOT have been executed
    assert.equal(executed, false)
  })

  test("mixed valid and invalid tool calls", async () => {
    const validCall = makeToolCall({ id: "valid_1", name: "file.read", arguments: { path: "/tmp/test.txt" } })
    const invalidCall = makeToolCall({ id: "invalid_1", arguments: {} }) // Missing command

    let executedCount = 0

    const results = await processToolCalls({
      toolCalls: [validCall, invalidCall],
      toolRegistry: registry,
      runtime: {
        async executeMany(inputs) {
          executedCount = inputs.length
          return inputs.map((i) => ({ id: i.id, ok: true, content: `ok_${i.id}` }))
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
    })

    assert.equal(results.length, 2)
    // Valid call executed
    assert.equal(results[0]!.result.status, "ok")
    assert.equal(results[0]!.result.contentForModel, "ok_valid_1")
    // Invalid call not executed
    assert.equal(results[1]!.result.status, "error")
    assert.ok(results[1]!.result.summary.includes("Invalid arguments"))
    // Only the valid call should have been executed
    assert.equal(executedCount, 1)
  })

  test("execution error returns error status", async () => {
    const call = makeToolCall()
    const results = await processToolCalls({
      toolCalls: [call],
      toolRegistry: registry,
      runtime: {
        async executeMany() {
          return [{ id: call.id, ok: false, content: "Command not found" }]
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
    })

    assert.equal(results.length, 1)
    assert.equal(results[0]!.result.status, "error")
    assert.equal(results[0]!.result.summary, "Command not found")
  })

  test("runtime exception during execution returns error for all approved calls", async () => {
    const call1 = makeToolCall({ id: "call_1" })
    const call2 = makeToolCall({ id: "call_2" })

    const results = await processToolCalls({
      toolCalls: [call1, call2],
      toolRegistry: registry,
      runtime: {
        async executeMany() {
          throw new Error("Service unavailable")
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
    })

    assert.equal(results.length, 2)
    assert.equal(results[0]!.result.status, "error")
    assert.equal(results[1]!.result.status, "error")
  })

  test("long output is truncated with head/tail", async () => {
    const call = makeToolCall()
    const longOutput = "A".repeat(3000) + "B".repeat(3000) + "C".repeat(3000) // 9000 chars

    const results = await processToolCalls({
      toolCalls: [call],
      toolRegistry: registry,
      runtime: {
        async executeMany() {
          return [{ id: call.id, ok: true, content: longOutput }]
        },
      },
      permission: {
        async check() {
          return { status: "approved", actions: [] }
        },
      },
      // Use small inline limit to force truncation
      inlineCharLimit: 100,
      summaryCharLimit: 50,
    })

    assert.equal(results.length, 1)
    assert.equal(results[0]!.result.status, "ok")
    assert.ok(results[0]!.result.contentForModel.includes("truncated"))
    assert.ok(results[0]!.result.contentForModel.length < 500) // Well within limit
    assert.equal(results[0]!.result.summary.length, 50) // Summary capped
  })

  test("empty tool call list returns empty results", async () => {
    const results = await processToolCalls({
      toolCalls: [],
      toolRegistry: registry,
      runtime: {
        async executeMany() { return [] },
      },
      permission: {
        async check() { return { status: "approved", actions: [] } },
      },
    })
    assert.equal(results.length, 0)
  })
})
