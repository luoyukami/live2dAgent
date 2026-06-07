/**
 * Tests for tool-schema.ts — encodeToolSchemas.
 *
 * Covers:
 *   - Basic encoding converts CanonicalToolDefinition to ProviderToolSchema
 *   - Internal fields (permission, execute, timeoutMs, riskLevel) are stripped
 *   - Nested internal fields are stripped recursively
 *   - Tools are sorted by name alphabetically
 *   - Empty input returns empty array
 *   - Non-object parameters are passed through
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { encodeToolSchemas } from "./tool-schema.js"
import type { CanonicalToolDefinition } from "../model/model-tool.js"

describe("encodeToolSchemas", () => {
  test("returns empty array for empty input", () => {
    const result = encodeToolSchemas([])
    assert.deepEqual(result, [])
  })

  test("basic encoding converts tool to provider format", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "file.read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ]

    const result = encodeToolSchemas(tools)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.type, "function")
    assert.equal(result[0]!.name, "file.read")
    assert.equal(result[0]!.description, "Read a file")
    assert.deepEqual(result[0]!.parameters, {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    })
  })

  test("strips internal fields from parameters", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "shell.run",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          // These should be stripped
          permission: "shell",
          timeoutMs: 30_000,
        },
      },
    ]

    const result = encodeToolSchemas(tools)
    assert.equal(result.length, 1)
    const params = result[0]!.parameters as Record<string, unknown>
    assert.equal(params.type, "object")
    assert.equal(params.permission, undefined)
    assert.equal(params.timeoutMs, undefined)
  })

  test("strips nested internal fields recursively", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "deep.tool",
        description: "Tool with nested internal fields",
        parameters: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              properties: {
                inner: { type: "string" },
              },
              permission: "shell",
              riskLevel: "high",
              execute: "shouldBeRemoved",
            },
          },
        },
      },
    ]

    const result = encodeToolSchemas(tools)
    const params = result[0]!.parameters as Record<string, unknown>
    const nested = (params.properties as Record<string, unknown>).nested as Record<string, unknown>
    assert.ok(nested.type === "object")
    assert.equal(nested.permission, undefined)
    assert.equal(nested.riskLevel, undefined)
    assert.equal(nested.execute, undefined)
    // Innocent fields remain
    const inner = (nested.properties as Record<string, unknown>).inner as Record<string, unknown>
    assert.deepEqual(inner, { type: "string" })
  })

  test("sorts tools by name alphabetically", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "zebra",
        description: "Last",
        parameters: { type: "object" },
      },
      {
        name: "alpha",
        description: "First",
        parameters: { type: "object" },
      },
      {
        name: "beta",
        description: "Middle",
        parameters: { type: "object" },
      },
    ]

    const result = encodeToolSchemas(tools)
    assert.equal(result.length, 3)
    assert.equal(result[0]!.name, "alpha")
    assert.equal(result[1]!.name, "beta")
    assert.equal(result[2]!.name, "zebra")
  })

  test("does not modify input array", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "b",
        description: "Second",
        parameters: { type: "object" },
      },
      {
        name: "a",
        description: "First",
        parameters: { type: "object" },
      },
    ]

    const originalOrder = tools.map((t) => t.name).join(",")
    encodeToolSchemas(tools)
    // Original array unchanged
    assert.equal(tools.map((t) => t.name).join(","), originalOrder)
  })

  test("passes through non-object parameters without stripping", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "simple",
        description: "Simple tool",
        parameters: { type: "string" },
      },
    ]

    const result = encodeToolSchemas(tools)
    assert.deepEqual(result[0]!.parameters, { type: "string" })
  })

  test("strips workspaceRoot field", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "tool",
        description: "Test",
        parameters: {
          type: "object",
          workspaceRoot: "/tmp/workspace",
        },
      },
    ]

    const result = encodeToolSchemas(tools)
    const params = result[0]!.parameters as Record<string, unknown>
    assert.equal(params.workspaceRoot, undefined)
  })

  test("handles array parameters", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "array.tool",
        description: "Array params",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                timeoutMs: 5000, // should be stripped
              },
            },
          },
        },
      },
    ]

    const result = encodeToolSchemas(tools)
    const params = result[0]!.parameters as Record<string, unknown>
    const items = (params.properties as Record<string, unknown>).items as Record<string, unknown>
    assert.ok(items.type === "array")
    if (typeof items.items === "object" && items.items !== null) {
      const itemSchema = items.items as Record<string, unknown>
      assert.equal(itemSchema.timeoutMs, undefined)
      assert.deepEqual((itemSchema.properties as Record<string, unknown>).name, { type: "string" })
    }
  })
})
