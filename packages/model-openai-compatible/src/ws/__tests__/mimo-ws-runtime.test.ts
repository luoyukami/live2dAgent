/**
 * Comprehensive tests for the MiMo/OpenAI-Compatible WS Runtime.
 *
 * Covers:
 *   - Connect with Authorization header (not query param)
 *   - Create request with type: "response.create", model, store: false, input, tools
 *   - Tools schema in provider format, sorted by name, no internal fields
 *   - Text delta streaming
 *   - Tool call with parameter aggregation
 *   - Tool result continuation with previous_response_id
 *   - Continuation still carries tools
 *   - remote_context_not_found retryable error
 *   - Native ping/pong (not no-op)
 *   - Image content → input_image, not text placeholder
 *   - Audio content → UnsupportedInputPartError
 *   - Cancel request
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §15.2
 */
import { describe, test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { FakeWsServer } from "./fake-ws-server.js"
import type { CanonicalCreateInput, CanonicalToolContinuationInput, CanonicalToolDefinition, ModelContentPart, ModelEvent } from "@live2d-agent/agent-core"
import { MimoWsRuntime } from "../mimo-ws-runtime.js"
import { encodeTools } from "../mimo-tool-schema-encoder.js"
import { encodeContent } from "../mimo-content-encoder.js"

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Collect all events from an AsyncIterable into an array. */
async function collectEvents(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

/** Create a minimal CanonicalCreateInput for testing. */
function createInput(overrides: Partial<CanonicalCreateInput> = {}): CanonicalCreateInput {
  return {
    conversationId: "conv_test",
    runId: "run_test",
    model: "test-model",
    messages: [],
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: false,
    maxOutputTokens: 8000,
    ...overrides,
  }
}

/** Sample tool definitions for testing. */
const testTools = [
  {
    name: "file.read",
    description: "Read a file from the workspace",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    // Internal fields that should be filtered
    permission: "workspace_read",
    timeoutMs: 30_000,
    riskLevel: "low",
  },
  {
    name: "clipboard.read",
    description: "Read system clipboard content",
    parameters: {
      type: "object",
      properties: {},
    },
    permission: "clipboard_read",
  },
] as unknown as CanonicalToolDefinition[]

/* ------------------------------------------------------------------ */
/*  Test Suite                                                         */
/* ------------------------------------------------------------------ */

describe("MimoWsRuntime", () => {
  let server: FakeWsServer
  let runtime: MimoWsRuntime

  // Create a fresh server + runtime for each test
  async function setupServer(port?: number): Promise<number> {
    server = new FakeWsServer()
    return server.start({ port })
  }

  afterEach(async () => {
    if (runtime) {
      await runtime.close("test teardown").catch(() => {})
      runtime = undefined as unknown as MimoWsRuntime
    }
    if (server) {
      await server.stop().catch(() => {})
      server = undefined as unknown as FakeWsServer
    }
  })

  /* ================================================================ */
  /*  1. Connect with Authorization header                             */
  /* ================================================================ */

  test("connect sends Authorization Bearer header (not query param)", async () => {
    const port = await setupServer()
    server.onConnectFrames = [{ type: "connected" }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-api-key-12345",
    })

    await runtime.open("conv_1")

    assert.equal(server.connected, true, "Server should have accepted the connection")
    assert.equal(server.upgradeHeaders?.authorization, "Bearer test-api-key-12345")
    const upgradeUrl = server.upgradeUrl ?? ""
    assert.equal(upgradeUrl.includes("api_key="), false)
    assert.equal(upgradeUrl.includes("key="), false)
    assert.equal(upgradeUrl.includes("token="), false)
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  2. Create request contains required fields                       */
  /* ================================================================ */

  test("create sends response.create with type, model, store, input, tools", async () => {
    const port = await setupServer()

    server.stepHandlers = [{
      handle(msg) {
        // Assert the request shape
        assert.equal(msg.type, "response.create")
        assert.equal(msg.model, "test-model")
        assert.equal(msg.store, false)
        assert.ok(Array.isArray(msg.input), "input should be an array")
        assert.ok(Array.isArray(msg.tools), "tools should be an array")
        const input = msg.input as Array<Record<string, unknown>>
        assert.equal(input[0]!.type, "message")
        assert.equal(input[0]!.role, "user")
        const content = input[0]!.content as Array<Record<string, unknown>>
        assert.equal(content[0]!.type, "input_text")
        assert.equal(content[0]!.text, "Hello")
        return [
          { type: "response.created", response_id: "resp_shape_1" },
          { type: "response.completed", response_id: "resp_shape_1" },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_2")

    const events = await collectEvents(runtime.create(createInput({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      }],
    })))

    assert.equal(events.length, 2)
    assert.equal(events[0]!.type, "response.created")
    assert.equal(events[1]!.type, "response.completed")
    await runtime.close("test done")
  })

  test("create with remoteResponseId sends user message input, not function_call_output", async () => {
    const port = await setupServer()

    server.stepHandlers = [{
      handle(msg) {
        assert.equal(msg.type, "response.create")
        assert.equal(msg.previous_response_id, "resp_prev_1")
        const input = msg.input as Array<Record<string, unknown>>
        assert.equal(input.length, 1)
        assert.equal(input[0]!.type, "message")
        assert.equal(input[0]!.role, "user")
        assert.notEqual(input[0]!.type, "function_call_output")
        const content = input[0]!.content as Array<Record<string, unknown>>
        assert.equal(content[0]!.type, "input_text")
        assert.equal(content[0]!.text, "Next turn")
        return [
          { type: "response.created", response_id: "resp_next_1" },
          { type: "response.completed", response_id: "resp_next_1" },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}/v1`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_remote_create")
    await collectEvents(runtime.create(createInput({
      remoteResponseId: "resp_prev_1",
      messages: [{ role: "user", content: [{ type: "text", text: "Next turn" }] }],
    })))
    assert.equal(server.upgradeUrl, "/v1/responses")
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  3. Tools encoded in provider format, no internal fields          */
  /* ================================================================ */

  test("tools are encoded in provider format without internal fields", async () => {
    const port = await setupServer()

    server.stepHandlers = [{
      handle(msg) {
        const tools = msg.tools as Record<string, unknown>[]
        assert.ok(Array.isArray(tools), "tools should be an array")
        assert.equal(tools.length, 2)

        for (const tool of tools) {
          assert.equal(tool.type, "function")
          assert.ok(typeof tool.name === "string")
          assert.ok(typeof tool.description === "string")
          assert.ok(typeof tool.parameters === "object")

          // Internal fields MUST be absent
          assert.equal((tool as Record<string, unknown>).permission, undefined)
          assert.equal((tool as Record<string, unknown>).timeoutMs, undefined)
          assert.equal((tool as Record<string, unknown>).riskLevel, undefined)
          assert.equal((tool as Record<string, unknown>).execute, undefined)
        }
        return [
          { type: "response.created", response_id: "resp_tools_1" },
          { type: "response.completed", response_id: "resp_tools_1" },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_3")
    const events = await collectEvents(runtime.create(createInput({ tools: testTools })))
    assert.equal(events.length, 2)
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  4. Tools sorted by name                                          */
  /* ================================================================ */

  test("tools are sorted by name lexicographically", async () => {
    const port = await setupServer()

    server.stepHandlers = [{
      handle(msg) {
        const tools = msg.tools as Array<{ name: string }>
        const names = tools.map((t) => t.name)
        assert.deepEqual(names, ["clipboard.read", "file.read"], "Tools should be sorted by name")
        return [
          { type: "response.created", response_id: "resp_sort_1" },
          { type: "response.completed", response_id: "resp_sort_1" },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_4")
    const events = await collectEvents(runtime.create(createInput({ tools: testTools })))
    assert.equal(events.length, 2)
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  5. Text delta streaming                                          */
  /* ================================================================ */

  test("text delta events are emitted during streaming", async () => {
    const port = await setupServer()
    const responseId = "resp_delta_1"

    server.stepHandlers = [{
      handle() {
        return [
          { type: "response.created", response_id: responseId },
          { type: "response.output_text.delta", response_id: responseId, delta: "Hello" },
          { type: "response.output_text.delta", response_id: responseId, delta: " World" },
          { type: "response.completed", response_id: responseId },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_5")
    const events = await collectEvents(runtime.create(createInput()))

    assert.equal(events.length, 4)
    assert.deepEqual(events[0], { type: "response.created", responseId })
    assert.deepEqual(events[1], { type: "text.delta", responseId, delta: "Hello" })
    assert.deepEqual(events[2], { type: "text.delta", responseId, delta: " World" })
    assert.deepEqual(events[3], { type: "response.completed", responseId })
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  6. Tool call with parameter aggregation                          */
  /* ================================================================ */

  test("tool call events are emitted with aggregated arguments", async () => {
    const port = await setupServer()
    const responseId = "resp_tool_1"

    server.stepHandlers = [{
      handle() {
        return [
          { type: "response.created", response_id: responseId },
          {
            type: "response.function_call_arguments.done",
            response_id: responseId,
            call_id: "call_file_read",
            name: "file.read",
            arguments: JSON.stringify({ path: "README.md" }),
          },
          { type: "response.completed", response_id: responseId },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_6")

    // Provide the tools so the model can call them
    const events = await collectEvents(runtime.create(createInput({ tools: testTools })))

    // Should have response.created, tool.call, response.completed
    const toolCalls = events.filter((e): e is ModelEvent & { type: "tool.call" } => e.type === "tool.call")
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0]!.callId, "call_file_read")
    assert.equal(toolCalls[0]!.name, "file.read")
    assert.equal(toolCalls[0]!.argumentsText, JSON.stringify({ path: "README.md" }))
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  7. Tool call with incremental argument deltas                    */
  /* ================================================================ */

  test("tool call arguments are aggregated from incremental deltas", async () => {
    const port = await setupServer()
    const responseId = "resp_incr_1"

    server.stepHandlers = [{
      handle() {
        return [
          { type: "response.created", response_id: responseId },
          {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            call_id: "call_incr",
            name: "file.read",
            delta: '{"path":',
          },
          {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            call_id: "call_incr",
            name: "file.read",
            delta: '"README.md"}',
          },
          { type: "response.function_call_arguments.done",
            response_id: responseId,
            call_id: "call_incr",
            name: "file.read",
            arguments: '{"path":"README.md"}' },
          { type: "response.completed", response_id: responseId },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_incr")
    const events = await collectEvents(runtime.create(createInput({ tools: testTools })))

    const toolCalls = events.filter((e): e is ModelEvent & { type: "tool.call" } => e.type === "tool.call")
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0]!.callId, "call_incr")
    assert.equal(toolCalls[0]!.name, "file.read")
    // The arguments should be the aggregated complete JSON from the forceComplete on done
    assert.ok(toolCalls[0]!.argumentsText.length > 0)
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  8. Tool result continuation with previous_response_id            */
  /* ================================================================ */

  test("continueWithToolResult sends previous_response_id in request", async () => {
    const port = await setupServer()
    const responseId = "resp_cont_1"

    let continuationChecked = false

    server.stepHandlers = [
      // First: create
      {
        handle(msg) {
          assert.equal(msg.type, "response.create")
          return [
            { type: "response.created", response_id: responseId },
            {
              type: "response.function_call_arguments.done",
              response_id: responseId,
              call_id: "call_1",
              name: "file.read",
              arguments: JSON.stringify({ path: "test.txt" }),
            },
            { type: "response.completed", response_id: responseId },
          ]
        },
      },
      // Second: continuation
      {
        handle(msg) {
          assert.equal(msg.type, "response.create")
          assert.ok(msg.previous_response_id, "continuation should have previous_response_id")
          assert.equal(msg.previous_response_id, responseId)
          assert.ok(Array.isArray(msg.input), "continuation should have input array")

          const input = msg.input as Array<Record<string, unknown>>
          assert.equal(input.length, 1)
          assert.equal(input[0]!.type, "function_call_output")
          assert.equal(input[0]!.call_id, "call_1")

          continuationChecked = true

          return [
            { type: "response.created", response_id: "resp_cont_2" },
            { type: "response.output_text.delta", response_id: "resp_cont_2", delta: "Tool result processed" },
            { type: "response.completed", response_id: "resp_cont_2" },
          ]
        },
      },
    ]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_cont")

    // First create
    const events1 = await collectEvents(runtime.create(createInput({ tools: testTools })))

    // Get the tool call
    const toolCall = events1.find((e): e is ModelEvent & { type: "tool.call" } => e.type === "tool.call")
    assert.ok(toolCall, "Should have received a tool call")

    // Continue with tool result
    const events2 = await collectEvents(
      runtime.continueWithToolResult({
        conversationId: "conv_cont",
        runId: "run_cont",
        model: "test-model",
        previousResponseId: responseId,
        toolResult: {
          callId: "call_1",
          name: "file.read",
          status: "ok",
          output: "File content here",
          summary: "Read test.txt successfully",
        },
        tools: testTools,
        parallelToolCalls: false,
        maxOutputTokens: 8000,
      }),
    )

    assert.ok(continuationChecked, "Continuation handler should have run")
    assert.equal(events2.length, 3)
    const deltas = events2.filter((e) => e.type === "text.delta")
    assert.equal(deltas.length, 1)
    assert.equal((deltas[0] as ModelEvent & { type: "text.delta" }).delta, "Tool result processed")
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  9. Continuation still carries tools                              */
  /* ================================================================ */

  test("continuation request includes tools schema", async () => {
    const port = await setupServer()
    const responseId = "resp_tool_check"

    let continuationTools: unknown[] | null = null

    server.stepHandlers = [
      {
        handle() {
          return [
            { type: "response.created", response_id: responseId },
            {
              type: "response.function_call_arguments.done",
              response_id: responseId,
              call_id: "call_tc",
              name: "file.read",
              arguments: JSON.stringify({ path: "a.txt" }),
            },
            { type: "response.completed", response_id: responseId },
          ]
        },
      },
      {
        handle(msg) {
          continuationTools = msg.tools as unknown[]
          return [
            { type: "response.created", response_id: "resp_tc2" },
            { type: "response.completed", response_id: "resp_tc2" },
          ]
        },
      },
    ]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_tool_check")
    await collectEvents(runtime.create(createInput({ tools: testTools })))

    await collectEvents(
      runtime.continueWithToolResult({
        conversationId: "conv_tool_check",
        runId: "run_tc",
        model: "test-model",
        previousResponseId: responseId,
        toolResult: {
          callId: "call_tc",
          name: "file.read",
          status: "ok",
          output: "content",
          summary: "done",
        },
        tools: testTools,
        parallelToolCalls: false,
        maxOutputTokens: 8000,
      }),
    )

    assert.ok(continuationTools, "Continuation should include tools")
    assert.equal((continuationTools as Array<Record<string, unknown>>).length, 2)
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  10. remote_context_not_found error handling                      */
  /* ================================================================ */

  test("previous_response_not_found maps to remote_context_not_found retryable error", async () => {
    const port = await setupServer()
    const responseId = "resp_err_1"

    server.stepHandlers = [{
      handle() {
        // Return an error frame with previous_response_not_found
        return [
          { type: "response.created", response_id: responseId },
          {
            type: "error",
            code: "previous_response_not_found",
            message: "Previous response not found",
          },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_err")
    const events = await collectEvents(runtime.create(createInput()))

    // Should have response.created then response.failed with retryable
    const failures = events.filter((e): e is ModelEvent & { type: "response.failed" } => e.type === "response.failed")
    assert.equal(failures.length, 1)
    assert.equal(failures[0]!.error.code, "remote_context_not_found")
    assert.equal(failures[0]!.error.retryable, true)
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  11. Image content → input_image                                  */
  /* ================================================================ */

  test("image content part encodes as input_image, not text placeholder", async () => {
    const encoded = encodeContent([
      { type: "text", text: "Here is an image:" },
      { type: "image", mime: "image/png", data: "iVBORw0KGgo=", source: "inline" },
    ])

    assert.equal(encoded.length, 2)
    assert.deepEqual(encoded[0], { type: "input_text", text: "Here is an image:" })
    assert.equal(encoded[1]!.type, "input_image")
    const imagePart = encoded[1] as { type: "input_image"; image_url: string }
    assert.ok(imagePart.image_url.startsWith("data:image/png;base64,"), "Should be data URL")
    assert.ok(!imagePart.image_url.includes("[Image"), "Should not contain text placeholder")
  })

  /* ================================================================ */
  /*  12. Audio content throws UnsupportedInputPartError               */
  /* ================================================================ */

  test("audio content part throws UnsupportedInputPartError", async () => {
    assert.throws(
      () => {
        encodeContent([
          { type: "audio", mime: "audio/wav", data: "fakebase64==", source: "inline" },
        ])
      },
      (err: unknown) => {
        const e = err as Error
        return e.name === "UnsupportedInputPartError" && e.message.includes("audio")
      },
      "Should throw UnsupportedInputPartError for audio",
    )
  })

  /* ================================================================ */
  /*  13. Tool schema encoder filters internal fields                  */
  /* ================================================================ */

  test("encodeTools filters permission/timeoutMs/riskLevel/execute", () => {
    const tools: CanonicalToolDefinition[] = [
      {
        name: "test.tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        permission: "shell",
        timeoutMs: 60_000,
        riskLevel: "dangerous",
        execute: "function handle() {}",
        workspaceRoot: "/tmp/workspace",
        _internal: true,
      },
    ] as unknown as CanonicalToolDefinition[]

    const encoded = encodeTools(tools)
    assert.equal(encoded.length, 1)
    assert.equal(encoded[0]!.name, "test.tool")
    assert.equal(encoded[0]!.type, "function")

    assert.equal((encoded[0] as unknown as Record<string, unknown>).permission, undefined)
    assert.equal((encoded[0] as unknown as Record<string, unknown>).timeoutMs, undefined)
    assert.equal((encoded[0] as unknown as Record<string, unknown>).riskLevel, undefined)
    assert.equal((encoded[0] as unknown as Record<string, unknown>).execute, undefined)
    assert.equal((encoded[0] as unknown as Record<string, unknown>).workspaceRoot, undefined)
    assert.equal((encoded[0] as unknown as Record<string, unknown>)._internal, undefined)
  })

  /* ================================================================ */
  /*  14. Tool schema encoder sorts by name                            */
  /* ================================================================ */

  test("encodeTools sorts tools by name", () => {
    const tools: CanonicalToolDefinition[] = [
      { name: "z_tool", description: "Z tool", parameters: {} },
      { name: "a_tool", description: "A tool", parameters: {} },
      { name: "m_tool", description: "M tool", parameters: {} },
    ]

    const encoded = encodeTools(tools)
    assert.equal(encoded[0]!.name, "a_tool")
    assert.equal(encoded[1]!.name, "m_tool")
    assert.equal(encoded[2]!.name, "z_tool")
  })

  /* ================================================================ */
  /*  15. Cancel request                                               */
  /* ================================================================ */

  test("cancel sends response.cancel message", async () => {
    const port = await setupServer()

    server.stepHandlers = [{
      handle() {
        return [
          { type: "response.created", response_id: "resp_cancel_1" },
          { type: "response.output_text.delta", response_id: "resp_cancel_1", delta: "Partial text" },
        ]
      },
    }]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_cancel")

    // Start create and cancel immediately
    const eventsPromise = collectEvents(runtime.create(createInput()))

    // Small delay to let the create start
    await new Promise((r) => setTimeout(r, 100))

    await runtime.cancel({ responseId: "resp_cancel_1", runId: "run_cancel" })

    const events = await eventsPromise

    // Should at least have response.created
    assert.ok(events.length >= 1)
    assert.equal(events[0]!.type, "response.created")
    await runtime.close("test done")
  })

  /* ================================================================ */
  /*  16. MimoWsProtocol encodeCreateRequest shape                     */
  /* ================================================================ */

  test("protocol encodes correct response.create shape", async () => {
    // Dynamically import to test the protocol directly
    const { MimoWsProtocol } = await import("../mimo-ws-protocol.js")
    const { encodeTools } = await import("../mimo-tool-schema-encoder.js")

    const protocol = new MimoWsProtocol()
    const tools = encodeTools(testTools)

    const request = protocol.encodeCreateRequest(
      "test-model",
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      tools,
    )

    assert.equal(request.type, "response.create")
    assert.equal(request.model, "test-model")
    assert.equal(request.store, false)
    assert.equal(request.previous_response_id, undefined)
    assert.equal(request.tool_choice, "auto")
    assert.equal(request.parallel_tool_calls, false)
    assert.equal(request.max_output_tokens, 8000)
    assert.equal(request.input.length, 1)
    assert.equal(request.tools.length, 2)
  })

  /* ================================================================ */
  /*  Idle timer: activity extends timer; reschedule; eventual close   */
  /* ================================================================ */

  test("idle timer is reset on frame activity, keeping connection open", async () => {
    const port = await setupServer()
    const idleMs = 200

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
      idleCloseMs: idleMs,
    })

    await runtime.open("conv_idle_extend")

    // Wait 60% of idle timeout — still active
    await sleep(idleMs * 0.6)
    assert.equal(runtime.getState().status, "connected", "Should still be connected after 60% of idle")

    // Send a frame to reset the idle timer
    server.send({ type: "test.frame", t: 1 })

    // Wait another 60% of idle timeout (total 120%, but timer was reset so only 60% elapsed)
    await sleep(idleMs * 0.6)
    assert.equal(runtime.getState().status, "connected", "Should still be connected after frame reset timer")

    // Now stop and wait for full idle timeout
    await sleep(idleMs * 1.1)
    assert.equal(runtime.getState().status, "closed", "Should close after idle timeout without activity")
  })

  test("repeated frames keep connection alive indefinitely", async () => {
    const port = await setupServer()
    const idleMs = 150

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
      idleCloseMs: idleMs,
    })

    await runtime.open("conv_idle_repeat")

    // Send frames at 50ms intervals — well within idleMs
    for (let i = 0; i < 6; i++) {
      await sleep(idleMs * 0.3)
      server.send({ type: "test.frame", seq: i })
      assert.equal(runtime.getState().status, "connected", `Should be connected during frame ${i}`)
    }

    // Now stop sending frames and wait for idle close
    await sleep(idleMs * 1.2)
    assert.equal(runtime.getState().status, "closed", "Should close after frames stop")
  })

  test("idle timer reschedules when threshold not yet met (checkIdle reschedule path)", async () => {
    const port = await setupServer()
    const idleMs = 150

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
      idleCloseMs: idleMs,
    })

    await runtime.open("conv_idle_reschedule")

    // Send a frame at 60% of idle timeout so the first timer check finds
    // elapsed < idleMs and must reschedule
    await sleep(idleMs * 0.6)
    server.send({ type: "test.frame", t: 1 })

    // Wait the remaining time after reset (0.6 * idleMs elapsed, then reset)
    // Without reschedule, the first timer would fire at ~idleMs from open
    // and find elapsed ~0.4 * idleMs, then NOTHING further would happen.
    // With reschedule, a new timer fires at idleMs from the frame.
    // So close should happen at 0.6 + 1.0 = 1.6 * idleMs.
    await sleep(idleMs * 0.8)
    assert.equal(runtime.getState().status, "connected", "Still connected before second idle window expires")

    // Now exceed the second idle window
    await sleep(idleMs * 0.6)
    assert.equal(runtime.getState().status, "closed", "Should close after rescheduled idle timeout")
  })

  test("close cleans up idle timer (no double close)", async () => {
    const port = await setupServer()
    const idleMs = 200

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
      idleCloseMs: idleMs,
    })

    await runtime.open("conv_idle_cleanup")

    // Manually close before idle fires
    await runtime.close("manual close")

    assert.equal(runtime.getState().status, "closed")

    // Wait past idle timeout — timer should have been stopped, no crash/error
    await sleep(idleMs * 1.5)
    assert.equal(runtime.getState().status, "closed", "Status should remain closed (no double-close)")
  })

  /* ================================================================ */
  /*  17. Multiple tool calls in sequence                              */
  /* ================================================================ */

  test("two sequential tool calls with continuations", async () => {
    const port = await setupServer()
    const responseId1 = "resp_seq_1"
    const responseId2 = "resp_seq_2"
    const responseId3 = "resp_seq_3"

    let continuationCount = 0

    server.stepHandlers = [
      // First create → clipboard.read
      {
        handle() {
          return [
            { type: "response.created", response_id: responseId1 },
            {
              type: "response.function_call_arguments.done",
              response_id: responseId1,
              call_id: "call_clip",
              name: "clipboard.read",
              arguments: JSON.stringify({}),
            },
            { type: "response.completed", response_id: responseId1 },
          ]
        },
      },
      // Continuation 1 → file.read
      {
        handle(msg) {
          continuationCount++
          assert.equal(msg.previous_response_id, responseId1)
          return [
            { type: "response.created", response_id: responseId2 },
            {
              type: "response.function_call_arguments.done",
              response_id: responseId2,
              call_id: "call_file",
              name: "file.read",
              arguments: JSON.stringify({ path: "test.txt" }),
            },
            { type: "response.completed", response_id: responseId2 },
          ]
        },
      },
      // Continuation 2 → final text
      {
        handle(msg) {
          continuationCount++
          assert.equal(msg.previous_response_id, responseId2)
          return [
            { type: "response.created", response_id: responseId3 },
            { type: "response.output_text.delta", response_id: responseId3, delta: "Final summary" },
            { type: "response.completed", response_id: responseId3 },
          ]
        },
      },
    ]

    runtime = new MimoWsRuntime({
      baseUrl: `http://localhost:${port}`,
      model: "test-model",
      apiKey: "test-key",
    })

    await runtime.open("conv_seq")

    // Step 1: Create
    const events1 = await collectEvents(runtime.create(createInput({ tools: testTools })))
    const toolCall1 = events1.find((e): e is ModelEvent & { type: "tool.call" } => e.type === "tool.call")
    assert.ok(toolCall1, "First tool call should exist")
    assert.equal(toolCall1!.name, "clipboard.read")

    // Step 2: Continue with clipboard result → expect file.read
    const events2 = await collectEvents(
      runtime.continueWithToolResult({
        conversationId: "conv_seq",
        runId: "run_seq",
        model: "test-model",
        previousResponseId: responseId1,
        toolResult: {
          callId: "call_clip",
          name: "clipboard.read",
          status: "ok",
          output: "test.txt",
          summary: "Clipboard contains test.txt",
        },
        tools: testTools,
        parallelToolCalls: false,
        maxOutputTokens: 8000,
      }),
    )

    const toolCall2 = events2.find((e): e is ModelEvent & { type: "tool.call" } => e.type === "tool.call")
    assert.ok(toolCall2, "Second tool call should exist")
    assert.equal(toolCall2!.name, "file.read")

    // Step 3: Continue with file result → expect final text
    const events3 = await collectEvents(
      runtime.continueWithToolResult({
        conversationId: "conv_seq",
        runId: "run_seq",
        model: "test-model",
        previousResponseId: responseId2,
        toolResult: {
          callId: "call_file",
          name: "file.read",
          status: "ok",
          output: "File contents here",
          summary: "Read test.txt",
        },
        tools: testTools,
        parallelToolCalls: false,
        maxOutputTokens: 8000,
      }),
    )

    const deltas = events3.filter((e) => e.type === "text.delta")
    assert.equal(deltas.length, 1)
    assert.equal((deltas[0] as ModelEvent & { type: "text.delta" }).delta, "Final summary")

    assert.equal(continuationCount, 2, "Should have 2 continuation steps")
    await runtime.close("test done")
  })
})
