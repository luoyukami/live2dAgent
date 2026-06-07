import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { JsonModelWsProtocol } from "./openai-compatible-ws-protocol.js"

describe("JsonModelWsProtocol", () => {
  test("decodes normalized text delta", () => {
    const protocol = new JsonModelWsProtocol()
    assert.deepEqual(
      protocol.decode(JSON.stringify({ type: "response.text.delta", responseId: "r1", delta: "hello" })),
      { type: "response.text.delta", responseId: "r1", delta: "hello" },
    )
  })

  test("decodes OpenAI-style tool call arguments", () => {
    const protocol = new JsonModelWsProtocol()
    assert.deepEqual(
      protocol.decode(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "r1",
        call_id: "call_1",
        name: "file.read",
        arguments: JSON.stringify({ path: "README.md" }),
      })),
      {
        type: "response.tool_call.created",
        responseId: "r1",
        toolCall: { id: "call_1", name: "file.read", arguments: { path: "README.md" } },
      },
    )
  })

  test("encodes outbound messages", () => {
    const protocol = new JsonModelWsProtocol()
    assert.equal(
      protocol.encode({ type: "ping" }),
      JSON.stringify({ type: "ping" }),
    )
  })
})
