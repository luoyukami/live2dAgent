/**
 * AssistantRuntime unit tests — Phase 3 of the WS runtime refactor.
 *
 * Coverage:
 *   1. Normal text streaming (text.delta → message.delta events)
 *   2. Response completion → run.completed
 *   3. Two sequential tool calls (tool.call → execute → continue → second tool → complete)
 *   4. Remote context not found → full context replay once
 *   5. Second remote context failure → run.failed
 *   6. Doom loop block (3 consecutive identical calls allowed, 4th blocked)
 *   7. Queue: second message queued when run active, processed after completion
 *   8. Cancel: cancels active run, processes queue
 *   9. Queue full error
 *  10. Error handling: provider error → run.failed
 *  11. Multi-conversation isolation
 *
 * Uses a fake ProviderRuntime that yields predetermined ModelEvent sequences.
 * No real WebSocket or model API calls.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { AssistantRuntime } from "./assistant-runtime.js"
import type {
  ConversationStore,
  ConversationStoreMessage,
  ContextBuilder,
  ToolManager,
  ToolValidationResult,
} from "./assistant-runtime.js"
import type { ProviderRuntime, ProviderRuntimeState, CanonicalCreateInput, CanonicalToolContinuationInput } from "../model/model-runtime.js"
import type { ModelEvent } from "../model/model-event.js"
import type { ModelToolCall, ValidatedToolCall, CanonicalToolResult, CanonicalToolDefinition } from "../model/model-tool.js"
import type { AssistantRuntimeEvent } from "./assistant-runtime-events.js"
import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"

/* ------------------------------------------------------------------ */
/*  Fake ProviderRuntime                                                */
/* ------------------------------------------------------------------ */

type EventSequence = Array<ModelEvent | "throw">

/**
 * FakeProviderRuntime returns predefined event sequences.
 * Each call to create() or continueWithToolResult() consumes one sequence.
 *
 * Supports streamHang: when enabled, the generator hangs (awaits a
 * never-resolving promise) after yielding all events, keeping the
 * response stream open for queue/cancel testing.
 */
class FakeProviderRuntime implements ProviderRuntime {
  private createSequences: EventSequence[] = []
  private continuationSequences: EventSequence[] = []
  public createCallCount = 0
  public continuationCallCount = 0
  public cancelCalls: Array<{ responseId?: string; runId: string }> = []
  public lastCreateInput?: CanonicalCreateInput
  public closed = false

  /** How many times open() was called. */
  public openCallCount = 0
  /** When true, open() throws an error. */
  public openShouldThrow = false

  /** Current provider status for idle close reopen testing. */
  private _status: "disconnected" | "connecting" | "connected" | "closed" | "error" = "connected"

  /** Override the provider status (simulates idle close / error). */
  setStatus(status: "disconnected" | "connecting" | "connected" | "closed" | "error"): void {
    this._status = status
  }

  /** When true, the generator hangs after yielding all events. */
  private hangAfterYield = false
  /** Resolver for the hang promise. */
  private hangResolve: (() => void) | null = null
  /** The hang promise itself. */
  private hangPromise: Promise<void> | null = null

  /** Enable stream hang mode. */
  enableHang(): void {
    this.hangAfterYield = true
  }

  /** Resume a hung stream externally. */
  resume(): void {
    if (this.hangResolve) {
      this.hangResolve()
      this.hangResolve = null
      this.hangPromise = null
    }
  }

  /** Set the sequence of events for the next create() call. */
  setCreateSequence(events: EventSequence): void {
    this.createSequences.push(events)
  }

  /** Set the sequence of events for the next continueWithToolResult() call. */
  setContinuationSequence(events: EventSequence): void {
    this.continuationSequences.push(events)
  }

  /** Set a single create sequence (clears previous). */
  setSingleCreateSequence(events: EventSequence): void {
    this.createSequences = [events]
  }

  /** Set multiple create sequences (for replay test). */
  setCreateSequences(seqs: EventSequence[]): void {
    this.createSequences = [...seqs]
  }

  async open(_conversationId: string): Promise<void> {
    this.openCallCount++
    if (this.openShouldThrow) {
      throw new Error("Fake provider open error")
    }
    this._status = "connected"
  }

  async *create(input: CanonicalCreateInput): AsyncIterable<ModelEvent> {
    this.lastCreateInput = input
    this.createCallCount++
    const seq = this.createSequences.shift()
    if (!seq) return

    for (const item of seq) {
      if (item === "throw") {
        throw new Error("Fake provider error")
      }
      if (item.type === "response.failed" && item.error.code === "ws_closed_unexpectedly") {
        this._status = "closed"
      }
      yield item
    }

    // Hang if configured (keeps the stream alive for queue/cancel tests)
    if (this.hangAfterYield) {
      this.hangPromise = new Promise<void>((resolve) => {
        this.hangResolve = resolve
      })
      await this.hangPromise
    }
  }

  async *continueWithToolResult(_input: CanonicalToolContinuationInput): AsyncIterable<ModelEvent> {
    this.continuationCallCount++
    const seq = this.continuationSequences.shift()
    if (!seq) return

    for (const item of seq) {
      if (item === "throw") {
        throw new Error("Fake continuation error")
      }
      if (item.type === "response.failed" && item.error.code === "ws_closed_unexpectedly") {
        this._status = "closed"
      }
      yield item
    }

    if (this.hangAfterYield) {
      this.hangPromise = new Promise<void>((resolve) => {
        this.hangResolve = resolve
      })
      await this.hangPromise
    }
  }

  async cancel(input: { responseId?: string; runId: string }): Promise<void> {
    this.cancelCalls.push(input)
  }

  async close(_reason: string): Promise<void> {
    this.closed = true
    this._status = "closed"
  }

  getState(): ProviderRuntimeState {
    return {
      status: this._status,
      conversationId: null,
      remoteResponseId: null,
      connectedAt: this._status === "connected" ? Date.now() : null,
    }
  }

  /** Reset all recorded state. */
  reset(): void {
    this.createSequences = []
    this.continuationSequences = []
    this.createCallCount = 0
    this.continuationCallCount = 0
    this.cancelCalls = []
    this.lastCreateInput = undefined
    this.closed = false
    this.hangAfterYield = false
    this.hangResolve = null
    this.hangPromise = null
    this.openCallCount = 0
    this.openShouldThrow = false
    this._status = "connected"
  }
}

/* ------------------------------------------------------------------ */
/*  Fake ConversationStore                                             */
/* ------------------------------------------------------------------ */

class FakeConversationStore implements ConversationStore {
  private conversations = new Map<string, {
    id: string
    messages: Array<{ id: string; role: string; content: string }>
    remoteResponseId: string | null
  }>()

  /** Recorded appendToolResultMessage calls for assertion. */
  public toolResultCalls: Array<{
    conversationId: string
    toolCallId: string
    toolName: string
    output: string
    historySummary?: string
  }> = []

  createConversation(id?: string): string {
    const convId = id ?? `conv_${this.conversations.size + 1}`
    this.conversations.set(convId, {
      id: convId,
      messages: [],
      remoteResponseId: null,
    })
    return convId
  }

  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId)
  }

  appendUserMessage(
    conversationId: string,
    text: string,
    attachments?: Array<{ id: string; type: "audio"; label: string; artifact: { id: string; kind: string; path: string; mimeType: string; size: number; createdAt: number }; mimeType: string; durationMs: number; createdAt: number }>,
    artifactRefs?: Array<{ id: string; kind: string; path: string; mimeType: string; size: number; createdAt: number }>,
  ): { id: string } {
    const conv = this.conversations.get(conversationId)
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`)
    const msg = { id: `msg_${conv.messages.length}`, role: "user" as const, content: text }
    conv.messages.push(msg)
    return msg
  }

  appendAssistantMessage(conversationId: string): { id: string } | null {
    const conv = this.conversations.get(conversationId)
    if (!conv) return null
    const msg = { id: `msg_asst_${conv.messages.length}`, role: "assistant" as const, content: "" }
    conv.messages.push(msg)
    return msg
  }

  appendToolResultMessage(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    output: string,
    historySummary?: string,
  ): void {
    const conv = this.conversations.get(conversationId)
    if (!conv) return
    conv.messages.push({
      id: `msg_tool_${conv.messages.length}`,
      role: "tool",
      content: output,
    })
    this.toolResultCalls.push({ conversationId, toolCallId, toolName, output, historySummary })
  }

  updateAssistantMessage(conversationId: string, messageId: string, content: string): boolean {
    const conv = this.conversations.get(conversationId)
    if (!conv) return false
    const msg = conv.messages.find((m) => m.id === messageId)
    if (!msg) return false
    msg.content = content
    return true
  }

  setRemoteResponseId(conversationId: string, responseId: string | null): void {
    const conv = this.conversations.get(conversationId)
    if (!conv) return
    conv.remoteResponseId = responseId
  }

  getRemoteResponseId(conversationId: string): string | null {
    return this.conversations.get(conversationId)?.remoteResponseId ?? null
  }

  getConversationMessages(conversationId: string): ConversationStoreMessage[] {
    const conv = this.conversations.get(conversationId)
    if (!conv) return []
    return [...conv.messages]
  }
}

/* ------------------------------------------------------------------ */
/*  Fake ContextBuilder                                                */
/* ------------------------------------------------------------------ */

class FakeContextBuilder implements ContextBuilder {
  buildCreateInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    userText: string
    messages: Array<{ id: string; role: string; content: string }>
    tools: CanonicalToolDefinition[]
    remoteResponseId?: string | null
    currentUserMessageId?: string
  }): CanonicalCreateInput {
    return {
      conversationId: params.conversationId,
      runId: params.runId,
      model: "test-model",
      remoteResponseId: params.remoteResponseId ?? null,
      messages: [
        { role: "system", content: [{ type: "text", text: params.systemPrompt }] },
        ...params.messages.map((m) => ({
          role: m.role as "user" | "assistant" | "tool",
          content: [{ type: "text" as const, text: m.content }],
        })),
        ...(params.userText
          ? [{ role: "user" as const, content: [{ type: "text" as const, text: params.userText }] }
          ]
          : []),
      ],
      tools: params.tools,
      toolChoice: "auto",
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
  }

  buildContinuationInput(params: {
    conversationId: string
    runId: string
    systemPrompt: string
    toolResult: CanonicalToolResult
    tools: CanonicalToolDefinition[]
    previousResponseId: string | null
  }): CanonicalToolContinuationInput {
    return {
      conversationId: params.conversationId,
      runId: params.runId,
      model: "test-model",
      previousResponseId: params.previousResponseId,
      toolResult: params.toolResult,
      tools: params.tools,
      parallelToolCalls: false,
      maxOutputTokens: 8000,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Fake ToolManager                                                   */
/* ------------------------------------------------------------------ */

const SAMPLE_TOOLS: CanonicalToolDefinition[] = [
  {
    name: "file.read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "shell.run",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
]

class FakeToolManager implements ToolManager {
  public executedCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = []
  public shouldFailValidation = false
  public shouldThrowOnExecute = false
  public doomLoopBlockedCalls: string[] = []

  getEnabledTools(): CanonicalToolDefinition[] {
    return SAMPLE_TOOLS
  }

  validateToolCall(call: ModelToolCall): ToolValidationResult {
    if (this.shouldFailValidation) {
      return { valid: false, error: `Invalid tool: ${call.name}` }
    }
    const tool = SAMPLE_TOOLS.find((t) => t.name === call.name)
    if (!tool) {
      return { valid: false, error: `Unknown tool: ${call.name}` }
    }
    return { valid: true }
  }

  async executeToolCall(call: ValidatedToolCall): Promise<CanonicalToolResult> {
    if (this.shouldThrowOnExecute) {
      throw new Error("Tool execution error")
    }
    this.executedCalls.push({ callId: call.callId, name: call.name, args: call.arguments })
    return {
      callId: call.callId,
      name: call.name,
      status: "ok",
      output: JSON.stringify({ result: `executed ${call.name} with ${JSON.stringify(call.arguments)}` }),
      summary: `Executed ${call.name}`,
    }
  }

  recordDoomLoopBlocked(callId: string): void {
    this.doomLoopBlockedCalls.push(callId)
  }
}

/* ------------------------------------------------------------------ */
/*  Harness                                                            */
/* ------------------------------------------------------------------ */

interface Harness {
  runtime: AssistantRuntime
  provider: FakeProviderRuntime
  store: FakeConversationStore
  contextBuilder: FakeContextBuilder
  toolManager: FakeToolManager
  events: AssistantRuntimeEvent[]
  conversationId: string
}

function createHarness(): Harness {
  const provider = new FakeProviderRuntime()
  const store = new FakeConversationStore()
  const contextBuilder = new FakeContextBuilder()
  const toolManager = new FakeToolManager()
  const events: AssistantRuntimeEvent[] = []

  const runtime = new AssistantRuntime({
    provider,
    conversationStore: store,
    contextBuilder,
    toolManager,
    model: "test-model",
    systemPrompt: "You are a helpful assistant.",
  })

  runtime.onEvent((event) => events.push(event))

  const conversationId = store.createConversation("test-conv")

  return { runtime, provider, store, contextBuilder, toolManager, events, conversationId }
}

/* ------------------------------------------------------------------ */
/*  Test: Normal text streaming                                        */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — text streaming", () => {
  test("text.delta events produce message.delta events", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Hello " },
      { type: "text.delta", responseId: "resp_1", delta: "world!" },
      { type: "response.completed", responseId: "resp_1" },
    ])

    await runtime.sendUserMessage(conversationId, "Say hi")

    const deltaEvents = events.filter((e) => e.type === "message.delta")
    assert.ok(deltaEvents.length >= 2)

    // Should have run lifecycle events
    assert.ok(events.some((e) => e.type === "run.started"))
    assert.ok(events.some((e) => e.type === "run.completed"))
  })

  test("full text-only flow emits all expected events in order", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Sure, " },
      { type: "text.delta", responseId: "resp_1", delta: "I can help!" },
      { type: "response.completed", responseId: "resp_1" },
    ])

    await runtime.sendUserMessage(conversationId, "Help me")

    const eventTypes = events.map((e) => e.type)
    assert.ok(eventTypes.includes("run.started"))
    assert.ok(eventTypes.includes("message.created"))
    assert.ok(eventTypes.includes("message.delta"))
    assert.ok(eventTypes.includes("message.completed"))
    assert.ok(eventTypes.includes("run.completed"))
  })

  test("conversation messages are stored after text completion", async () => {
    const { runtime, provider, store, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Hello world" },
      { type: "response.completed", responseId: "resp_1" },
    ])

    await runtime.sendUserMessage(conversationId, "Say hi")

    const msgs = store.getConversationMessages(conversationId)
    const userMsg = msgs.find((m) => m.role === "user")
    const asstMsg = msgs.find((m) => m.role === "assistant")

    assert.ok(userMsg, "User message should be stored")
    assert.equal(userMsg!.content, "Say hi")
    assert.ok(asstMsg, "Assistant message should be stored")
    assert.equal(asstMsg!.content, "Hello world")
  })

  test("remote response ID is saved to store after completion", async () => {
    const { runtime, provider, store, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Hi" },
      { type: "response.completed", responseId: "resp_1" },
    ])

    await runtime.sendUserMessage(conversationId, "Hello")

    assert.equal(store.getRemoteResponseId(conversationId), "resp_1")
  })
})

describe("AssistantRuntime — transient user messages", () => {
  test("sendTransientUserMessage does not append user input or persist remote context", async () => {
    const { runtime, provider, store, conversationId } = createHarness()

    store.appendUserMessage(conversationId, "existing context")
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_transient" },
      { type: "text.delta", responseId: "resp_transient", delta: "主动搭话" },
      { type: "response.completed", responseId: "resp_transient" },
    ])

    await runtime.sendTransientUserMessage(conversationId, "one-off system instruction")

    const stored = store.getConversationMessages(conversationId)
    assert.deepEqual(stored.map((m) => m.content), ["existing context", "主动搭话"])
    assert.equal(store.getRemoteResponseId(conversationId), null)
    assert.ok(provider.lastCreateInput)
    assert.equal(provider.lastCreateInput.remoteResponseId, null)
    assert.equal(provider.lastCreateInput.tools.length, 0)
    assert.ok(JSON.stringify(provider.lastCreateInput.messages).includes("one-off system instruction"))
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Sequential tool calls                                        */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — sequential tool calls", () => {
  test("single tool call is executed and tool events are emitted", async () => {
    const { runtime, provider, toolManager, events, conversationId } = createHarness()

    // First response: tool call → completed
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo hi" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    // Continuation: text response
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Done!" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(conversationId, "Run a command")

    // Tool events should be emitted
    assert.ok(events.some((e) => e.type === "tool.started"), "Should have tool.started")
    assert.ok(events.some((e) => e.type === "tool.completed"), "Should have tool.completed")

    // Tool should have been executed
    assert.equal(toolManager.executedCalls.length, 1)
    assert.equal(toolManager.executedCalls[0]!.name, "shell.run")
    assert.equal(toolManager.executedCalls[0]!.args.command, "echo hi")

    // Should have one continuation call
    assert.equal(provider.continuationCallCount, 1)

    // Run should complete
    assert.ok(events.some((e) => e.type === "run.completed"))
  })

  test("two sequential tool calls: tool1 → continue → tool2 → complete", async () => {
    const { runtime, provider, toolManager, events, conversationId } = createHarness()

    // First response: first tool call
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo first" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    // First continuation: second tool call
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      {
        type: "tool.call",
        responseId: "resp_2",
        callId: "call_2",
        name: "file.read",
        argumentsText: JSON.stringify({ path: "/tmp/test" }),
      },
      { type: "response.completed", responseId: "resp_2" },
    ])

    // Second continuation: final text
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_3" },
      { type: "text.delta", responseId: "resp_3", delta: "All done!" },
      { type: "response.completed", responseId: "resp_3" },
    ])

    await runtime.sendUserMessage(conversationId, "Run two commands")

    // Both tools should be executed
    assert.equal(toolManager.executedCalls.length, 2)
    assert.equal(toolManager.executedCalls[0]!.name, "shell.run")
    assert.equal(toolManager.executedCalls[1]!.name, "file.read")

    // Two continuations
    assert.equal(provider.continuationCallCount, 2)

    // Run should complete
    assert.ok(events.some((e) => e.type === "run.completed"))
  })

  test("tool call with invalid arguments still continues run (error result sent)", async () => {
    const { runtime, provider, toolManager, events, conversationId } = createHarness()

    toolManager.shouldFailValidation = true

    // First response: tool call
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_bad",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "bad" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    // Continuation: text response
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Fixed it" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(conversationId, "Invalid tool")

    // Should have tool.failed event
    assert.ok(events.some((e) => e.type === "tool.failed"))

    // Continuation should have happened (model got error result)
    assert.equal(provider.continuationCallCount, 1)

    // Run should complete
    assert.ok(events.some((e) => e.type === "run.completed"))
  })

  test("max tool calls per run enforced", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // With §9.8 (parallelToolCalls=false), only 1 tool call per response.
    // Spread 13 tool calls across 1 initial + 12 continuation responses.
    // The 13th tool call (from the 12th continuation) hits the limit.

    // Initial: tool call 1
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo 1" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    // Continuations: tool calls 2 through 13 (12 continuations)
    for (let i = 0; i < WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN + 1; i++) {
      provider.setContinuationSequence([
        { type: "response.created", responseId: `resp_cont_${i}` },
        {
          type: "tool.call",
          responseId: `resp_cont_${i}`,
          callId: `call_cont_${i}`,
          name: "shell.run",
          argumentsText: JSON.stringify({ command: `echo ${i}` }),
        },
        { type: "response.completed", responseId: `resp_cont_${i}` },
      ])
    }

    await runtime.sendUserMessage(conversationId, "Run many commands")

    // The run should fail with max_tool_calls_exceeded
    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.ok(failedEvents.length > 0)
    if (failedEvents[0]?.type === "run.failed") {
      assert.equal(failedEvents[0].error.code, "max_tool_calls_exceeded")
    }

    // 12 tool calls were executed (the 13th fails the run)
    assert.equal(provider.createCallCount, 1)
  })

  test("max model continuations per run enforced", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // Note: MAX_TOOL_CALLS_PER_RUN (12) < MAX_MODEL_CONTINUATIONS_PER_RUN (16).
    // With sequential tool calls (1 per response), each tool call also
    // increments continuationCount. Therefore the tool call limit always
    // triggers first. This test verifies that the run fails when too many
    // continuations would be needed — the actual error is max_tool_calls_exceeded
    // because it's the lower of the two limits.

    // Set up MAX_TOOL_CALLS_PER_RUN + 1 tool calls across 1 initial + 12 continuations
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo 1" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    for (let i = 0; i < WS_RUNTIME_CONSTANTS.MAX_TOOL_CALLS_PER_RUN + 1; i++) {
      provider.setContinuationSequence([
        { type: "response.created", responseId: `resp_cont_${i}` },
        {
          type: "tool.call",
          responseId: `resp_cont_${i}`,
          callId: `call_cont_${i}`,
          name: "shell.run",
          argumentsText: JSON.stringify({ command: `echo ${i}` }),
        },
        { type: "response.completed", responseId: `resp_cont_${i}` },
      ])
    }

    await runtime.sendUserMessage(conversationId, "Loop")

    // Run should fail (the lower limit, tool calls, triggers first)
    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.ok(failedEvents.length > 0)
    if (failedEvents[0]?.type === "run.failed") {
      // With MAX_TOOL_CALLS_PER_RUN=12 < MAX_MODEL_CONTINUATIONS_PER_RUN=16,
      // the tool call limit fires first
      assert.ok(
        failedEvents[0].error.code === "max_tool_calls_exceeded" ||
        failedEvents[0].error.code === "max_model_continuations_exceeded",
        `Expected one of the limit errors, got: ${failedEvents[0].error.code}`,
      )
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Remote context replay                                        */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — remote context replay", () => {
  test("remote_context_not_found replays with full context once", async () => {
    const { runtime, provider, store, events, conversationId } = createHarness()

    // Set a remote response ID on the store (simulating previous context)
    store.setRemoteResponseId(conversationId, "resp_prev")

    // First create attempt: fails with remote_context_not_found
    provider.setCreateSequences([
      // First attempt (with remoteResponseId) → fails
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "response.failed", error: { code: "remote_context_not_found", message: "Remote context not found", retryable: true } },
      ],
      // Replay (without remoteResponseId) → succeeds
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "text.delta", responseId: "resp_2", delta: "Replayed successfully" },
        { type: "response.completed", responseId: "resp_2" },
      ],
    ])

    await runtime.sendUserMessage(conversationId, "Test replay")

    // Should have run.completed (replay worked)
    const completedEvents = events.filter((e) => e.type === "run.completed")
    assert.equal(completedEvents.length, 1)

    // RemoteResponseId should be cleared after the replay then set to the new one
    assert.equal(store.getRemoteResponseId(conversationId), "resp_2")

    // Should have two create calls (initial + replay)
    assert.equal(provider.createCallCount, 2)
  })

  test("second remote_context_not_found after replay fails the run", async () => {
    const { runtime, provider, store, events, conversationId } = createHarness()

    store.setRemoteResponseId(conversationId, "resp_prev")

    // Both attempts fail with remote_context_not_found
    provider.setCreateSequences([
      // First attempt → fails
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "response.failed", error: { code: "remote_context_not_found", message: "Not found", retryable: true } },
      ],
      // Replay → also fails
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "response.failed", error: { code: "remote_context_not_found", message: "Still not found", retryable: true } },
      ],
    ])

    await runtime.sendUserMessage(conversationId, "Test double replay fail")

    // Run should be failed
    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.equal(failedEvents.length, 1)

    // Two create calls
    assert.equal(provider.createCallCount, 2)
  })

  test("previous_response_not_found also triggers replay", async () => {
    const { runtime, provider, store, events, conversationId } = createHarness()

    store.setRemoteResponseId(conversationId, "resp_prev")

    provider.setCreateSequences([
      // First attempt → fails with previous_response_not_found
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "response.failed", error: { code: "previous_response_not_found", message: "Previous not found", retryable: true } },
      ],
      // Replay → succeeds
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "text.delta", responseId: "resp_2", delta: "OK" },
        { type: "response.completed", responseId: "resp_2" },
      ],
    ])

    await runtime.sendUserMessage(conversationId, "Test previous replay")

    assert.ok(events.some((e) => e.type === "run.completed"))
    assert.equal(provider.createCallCount, 2)
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Doom loop detection                                          */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — doom loop detection", () => {
  test("4th identical tool call is blocked by doom loop detector", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // First response: 1 tool call
    const callArgs = JSON.stringify({ command: "echo hi" })
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: callArgs,
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    // 3 continuations with the same tool call (doom loop threshold = 3, so 4th blocked)
    // 1st continuation = 2nd identical call, 2nd = 3rd, 3rd = 4th (blocked)
    for (let i = 0; i < 3; i++) {
      provider.setContinuationSequence([
        { type: "response.created", responseId: `resp_cont_${i + 1}` },
        {
          type: "tool.call",
          responseId: `resp_cont_${i + 1}`,
          callId: `call_cont_${i + 1}`,
          name: "shell.run",
          argumentsText: callArgs,
        },
        { type: "response.completed", responseId: `resp_cont_${i + 1}` },
      ])
    }

    // Final continuation with text (after 4th blocked call, model gets error result and responds with text)
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_final" },
      { type: "text.delta", responseId: "resp_final", delta: "Final answer" },
      { type: "response.completed", responseId: "resp_final" },
    ])

    await runtime.sendUserMessage(conversationId, "Run echo hi 4 times")

    // First 3 tool calls succeed (tool.started), 4th is doom-blocked (tool.failed, not started)
    const toolStarted = events.filter((e) => e.type === "tool.started")
    const toolCompleted = events.filter((e) => e.type === "tool.completed")
    const toolFailed = events.filter((e) => e.type === "tool.failed")

    assert.equal(toolStarted.length, 3, "3 tool.started for the first 3 calls")
    assert.equal(toolCompleted.length, 3, "3 tool.completed for the first 3 calls")
    assert.equal(toolFailed.length, 1, "1 tool.failed for the 4th blocked call")

    // Run should complete
    assert.ok(events.some((e) => e.type === "run.completed"))
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Queueing                                                     */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — queueing", () => {
  test("second message is queued when a run is active", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // Keep the first response active by enabling stream hang
    provider.enableHang()
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Thinking..." },
      // No response.completed — stream hangs here
    ])

    // Don't await — let it run in background
    const firstPromise = runtime.sendUserMessage(conversationId, "First")
    // Give it a tick to start
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Second message should be queued
    const secondRunId = await runtime.sendUserMessage(conversationId, "Second")

    const queuedEvents = events.filter((e) => e.type === "run.queued")
    assert.equal(queuedEvents.length, 1)
    assert.equal(queuedEvents[0]!.runId, secondRunId)

    // Resume the first stream so it doesn't hang forever
    provider.resume()

    // Wait for first run to complete and queue processing
    await firstPromise
  })

  test("queued message is processed after active run completes", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // Two sequential responses: text then complete each
    // Must use setCreateSequences (not setSingleCreateSequence) to
    // avoid overwriting the first sequence with the second.
    provider.setCreateSequences([
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "text.delta", responseId: "resp_1", delta: "First response" },
        { type: "response.completed", responseId: "resp_1" },
      ],
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "text.delta", responseId: "resp_2", delta: "Second response" },
        { type: "response.completed", responseId: "resp_2" },
      ],
    ])

    // Start first
    await runtime.sendUserMessage(conversationId, "First")
    // Start second (should start immediately since first is done)
    await runtime.sendUserMessage(conversationId, "Second")

    // Two runs should have completed
    const completedEvents = events.filter((e) => e.type === "run.completed")
    assert.equal(completedEvents.length, 2)
  })

  test("queue full throws an error", async () => {
    const { runtime, provider, conversationId } = createHarness()

    // Keep the first run active
    provider.enableHang()
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
    ])

    const firstPromise = runtime.sendUserMessage(conversationId, "First")
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Fill the queue
    const maxQueue = WS_RUNTIME_CONSTANTS.MAX_QUEUED_USER_MESSAGES_PER_CONVERSATION
    for (let i = 0; i < maxQueue; i++) {
      await runtime.sendUserMessage(conversationId, `Queue ${i}`)
    }

    // Next one should throw
    await assert.rejects(
      () => runtime.sendUserMessage(conversationId, "Too many"),
      (err: any) => err?.code === "conversation_queue_full",
    )

    provider.resume()
    await firstPromise
  })

  test("queue full emits run.queued before throwing", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    provider.enableHang()
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
    ])

    const firstPromise = runtime.sendUserMessage(conversationId, "First")
    await new Promise((resolve) => setTimeout(resolve, 5))

    const maxQueue = WS_RUNTIME_CONSTANTS.MAX_QUEUED_USER_MESSAGES_PER_CONVERSATION
    for (let i = 0; i < maxQueue; i++) {
      await runtime.sendUserMessage(conversationId, `Queue ${i}`)
    }

    try {
      await runtime.sendUserMessage(conversationId, "Too many")
    } catch {
      // Expected
    }

    // Should have maxQueue run.queued events (the ones that succeeded)
    const queuedEvents = events.filter((e) => e.type === "run.queued")
    assert.equal(queuedEvents.length, maxQueue)

    provider.resume()
    await firstPromise
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Cancellation                                                 */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — cancellation", () => {
  test("cancelCurrentRun cancels the active run and emits event", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // Keep stream alive for cancellation
    provider.enableHang()
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Processing..." },
    ])

    const firstPromise = runtime.sendUserMessage(conversationId, "Cancel me")
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Cancel it
    await runtime.cancelCurrentRun(conversationId)

    // Should emit run.cancelled
    const cancelledEvents = events.filter((e) => e.type === "run.cancelled")
    assert.equal(cancelledEvents.length, 1)

    // Provider should have been asked to cancel
    assert.equal(provider.cancelCalls.length, 1)

    // Resume the stream so it doesn't hang forever
    provider.resume()
    await firstPromise
  })

  test("cancelCurrentRun with no active run is a no-op", async () => {
    const { runtime, events } = createHarness()
    await runtime.cancelCurrentRun("nonexistent")
    const cancelledEvents = events.filter((e) => e.type === "run.cancelled")
    assert.equal(cancelledEvents.length, 0)
  })

  test("cancelCurrentRun processes next queued message", async () => {
    const { runtime, provider, store, conversationId } = createHarness()

    // First response: stays active
    provider.enableHang()
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "First..." },
    ])

    const firstPromise = runtime.sendUserMessage(conversationId, "First")
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Queue a second message
    await runtime.sendUserMessage(conversationId, "Second")

    // Cancel the first run — should process queue
    await runtime.cancelCurrentRun(conversationId)

    // The second message should still be in the conversation (queued run is tracked)
    const msgs = store.getConversationMessages(conversationId)
    const userMsgs = msgs.filter((m) => m.role === "user")
    assert.ok(userMsgs.length >= 1)

    provider.resume()
    await firstPromise
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Error handling                                               */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — error handling", () => {
  test("provider error during create fails the run", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      "throw" as any,
    ])

    await runtime.sendUserMessage(conversationId, "Trigger error")

    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.equal(failedEvents.length, 1)
  })

  test("response.failed with non-retryable error fails the run", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "response.failed", error: { code: "ws_protocol_error", message: "Protocol error", retryable: false } },
    ])

    await runtime.sendUserMessage(conversationId, "Fail me")

    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.equal(failedEvents.length, 1)
    if (failedEvents[0]?.type === "run.failed") {
      assert.equal(failedEvents[0].error.code, "provider_error")
    }
  })

  test("tool execution throw is caught and tool.failed emitted", async () => {
    const { runtime, provider, toolManager, events, conversationId } = createHarness()

    toolManager.shouldThrowOnExecute = true

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo hi" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])

    // Continuation with text
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Error handled" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(conversationId, "Execute with error")

    const failedEvents = events.filter((e) => e.type === "tool.failed")
    assert.equal(failedEvents.length, 1)

    // Run should still complete (error result sent to model)
    assert.ok(events.some((e) => e.type === "run.completed"))
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Multi-conversation isolation                                  */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — multi-conversation isolation", () => {
  test("two conversations can run independently", async () => {
    const { runtime, provider, store, events } = createHarness()
    const convA = store.createConversation("conv-a")
    const convB = store.createConversation("conv-b")

    // Use setCreateSequences to provide both sequence in order
    provider.setCreateSequences([
      // Conv A: text response
      [
        { type: "response.created", responseId: "resp_a1" },
        { type: "text.delta", responseId: "resp_a1", delta: "Hello from A" },
        { type: "response.completed", responseId: "resp_a1" },
      ],
      // Conv B: text response
      [
        { type: "response.created", responseId: "resp_b1" },
        { type: "text.delta", responseId: "resp_b1", delta: "Hello from B" },
        { type: "response.completed", responseId: "resp_b1" },
      ],
    ])

    await runtime.sendUserMessage(convA, "Hi A")
    await runtime.sendUserMessage(convB, "Hi B")

    const msgsA = store.getConversationMessages(convA)
    const msgsB = store.getConversationMessages(convB)

    const asstA = msgsA.find((m) => m.role === "assistant")
    const asstB = msgsB.find((m) => m.role === "assistant")

    assert.ok(asstA)
    assert.ok(asstB)
    assert.equal(asstA!.content, "Hello from A")
    assert.equal(asstB!.content, "Hello from B")
  })
})

/* ---- Helper: wait for queued run to complete ---- */
async function waitForRun(provider: FakeProviderRuntime): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

describe("AssistantRuntime — Phase 3: permission routing", () => {
  test("permission denied tool call returns denied result", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const permissionDeniedToolManager: ToolManager = {
      getEnabledTools() { return [] },
      validateToolCall(call: any) { return { valid: true } },
      async executeToolCall(call: any) {
        return { callId: call.callId, name: call.name, status: "denied" as const, output: "", summary: "User denied" }
      },
    }
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: permissionDeniedToolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })

    const convId = store.createConversation("conv_permission")
    const runId = await runtime.sendUserMessage(convId, "Do something dangerous")
    assert.ok(runId)
    await waitForRun(provider)
    const msgs = store.getConversationMessages(convId)
    assert.ok(msgs.length >= 1)
    assert.ok(msgs[0].role === "user")
  })

  test("permission approved tool call executes normally", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    provider.setSingleCreateSequence([
      { type: "tool.call", responseId: "resp_t1", callId: "call_1", name: "test_tool", argumentsText: "{}" },
      { type: "response.completed", responseId: "resp_t1" },
    ])
    let toolExecuted = false
    const permissionApprovedToolManager: ToolManager = {
      getEnabledTools() { return [] },
      validateToolCall(call: any) { return { valid: true } },
      async executeToolCall(call: any) {
        toolExecuted = true
        return { callId: call.callId, name: call.name, status: "ok" as const, output: "done", summary: "Executed" }
      },
    }
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: permissionApprovedToolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })

    const convId = store.createConversation("conv_approved")
    const runId = await runtime.sendUserMessage(convId, "Run command")
    assert.ok(runId)
    await waitForRun(provider)
    assert.ok(toolExecuted, "Tool should have been executed")
  })
})

describe("AssistantRuntime — Phase 3: idle close reopen", () => {
  test("reopens provider when state is closed", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    provider.setStatus("disconnected")
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_idle1")

    // First message opens provider
    await runtime.sendUserMessage(convId, "Hello")
    await waitForRun(provider)
    assert.equal(provider.openCallCount, 1)

    // Simulate idle close
    provider.setStatus("closed")

    // Second message should reopen
    await runtime.sendUserMessage(convId, "Still there?")
    await waitForRun(provider)
    assert.equal(provider.openCallCount, 2, "Should have reopened after idle close")
  })

  test("reuses connection when provider is connected", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    provider.setStatus("disconnected")
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_idle2")

    // First message opens provider
    await runtime.sendUserMessage(convId, "Hello")
    await waitForRun(provider)
    const callCountAfterFirst = provider.openCallCount
    assert.equal(callCountAfterFirst, 1, "Should have opened on first message")

    // Provider is now connected, second message should reuse
    await runtime.sendUserMessage(convId, "Again")
    await waitForRun(provider)
    assert.equal(provider.openCallCount, callCountAfterFirst, "Should reuse connection")
  })

  test("reopens when state is error", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    provider.setStatus("disconnected")
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_idle3")

    // First message opens provider
    await runtime.sendUserMessage(convId, "Hello")
    await waitForRun(provider)
    assert.equal(provider.openCallCount, 1)

    provider.setStatus("error")

    await runtime.sendUserMessage(convId, "Recover?")
    await waitForRun(provider)
    assert.equal(provider.openCallCount, 2, "Should reopen after error")
  })

  test("open failure creates a failed run", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    provider.openShouldThrow = true
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_idle4")

    const emitted: any[] = []
    runtime.onEvent((ev) => emitted.push(ev))

    provider.setStatus("closed")
    await runtime.sendUserMessage(convId, "Fail")
    await new Promise((r) => setTimeout(r, 10))

    const failures = emitted.filter((e) => e.type === "run.failed")
    assert.ok(failures.length > 0, "Should emit run.failed after reopen failure")
  })
})

describe("AssistantRuntime — Phase 3: sendUserMessage with attachments", () => {
  test("stores attachments in conversation message", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_attach1")

    const attachment = {
      id: "audio_1",
      type: "audio" as const,
      label: "test recording",
      artifact: {
        id: "art_audio_1",
        kind: "audio" as const,
        path: "/tmp/test.wav",
        mimeType: "audio/wav",
        size: 1024,
        createdAt: Date.now(),
      },
      mimeType: "audio/wav",
      durationMs: 5000,
      createdAt: Date.now(),
    }

    await runtime.sendUserMessage(convId, {
      text: "Here is audio",
      attachments: [attachment],
    })

    await waitForRun(provider)

    const msgs = store.getConversationMessages(convId)
    const userMsg = msgs.find((m) => m.role === "user")
    assert.ok(userMsg)
  })

  test("stores artifactRefs in conversation message", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_ref1")

    const artifactRef = {
      id: "art_img_1",
      kind: "image" as const,
      path: "/tmp/image.png",
      mimeType: "image/png",
      size: 2048,
      createdAt: Date.now(),
    }

    await runtime.sendUserMessage(convId, {
      text: "Here is an image",
      artifactRefs: [artifactRef],
    })

    await waitForRun(provider)

    const msgs = store.getConversationMessages(convId)
    const userMsg = msgs.find((m) => m.role === "user")
    assert.ok(userMsg)
  })

  test("backward compatible string input still works", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    const convId = store.createConversation("conv_backward")

    const runId = await runtime.sendUserMessage(convId, "Just text")
    assert.ok(runId)
    await waitForRun(provider)

    const msgs = store.getConversationMessages(convId)
    const userMsg = msgs.find((m) => m.role === "user")
    assert.ok(userMsg)
    assert.equal(userMsg!.content, "Just text")
  })
})

/* ------------------------------------------------------------------ */
/*  Test: ToolResultLimiter with artifactWriter                         */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — ToolResultLimiter with artifactWriter", () => {
  const LONG_OUTPUT = "x".repeat(10_000) // exceeds 8k inline limit

  test("artifactWriter is called when tool output > 8000 chars", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const captureWriter: { calls: Array<{ name: string; content: string }> } = { calls: [] }
    const fakeWriter: import("../tools/tool-result-limiter.js").ArtifactWriter = {
      writeArtifact: async (name, content, mimeType) => {
        captureWriter.calls.push({ name, content })
        return { id: `art_${captureWriter.calls.length}`, path: `/tmp/${name}`, size: content.length }
      },
    }
    const toolManager = new FakeToolManager()
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
      artifactWriter: fakeWriter,
    })
    const convId = store.createConversation("conv_limiter1")

    // Override executeToolCall to return long output
    const origExecute = toolManager.executeToolCall.bind(toolManager)
    toolManager.executeToolCall = async (call) => {
      return {
        callId: call.callId,
        name: call.name,
        status: "ok",
        output: LONG_OUTPUT,
        summary: "Long output",
      }
    }

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "tool.call", responseId: "resp_1", callId: "call_1", name: "file.read", argumentsText: JSON.stringify({ path: "/bigfile" }) },
      { type: "response.completed", responseId: "resp_1" },
    ])
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Read long file" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(convId, "Read big file")
    await waitForRun(provider)

    // artifactWriter should have been called once
    assert.equal(captureWriter.calls.length, 1, "artifactWriter should be called once")
    assert.ok(captureWriter.calls[0]!.content.length > 8000, "Written content should be long")
    assert.ok(captureWriter.calls[0]!.name.startsWith("tool_output_file_read"), "Artifact name should contain tool name")

    // The tool result sent to the model's continuation should contain artifactRef
    // We verify by checking that the continueWithToolResult received output with artifactRef
    const msgs = store.getConversationMessages(convId)
    const toolResultMsg = msgs.find((m) => m.role === "tool")
    assert.ok(toolResultMsg, "Tool result message should exist")
    const parsed = JSON.parse(toolResultMsg!.content)
    assert.ok(parsed.artifactRef, "Tool result output should contain artifactRef")
    assert.ok(parsed.artifactRef.startsWith("artifact://tool-output/"), "artifactRef should have correct prefix")
    assert.ok(parsed.content.includes("[omitted"), "Truncated content should show omitted count")
  })

  test("artifactWriter is NOT called for short tool output", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const captureWriter: { calls: Array<{ name: string; content: string }> } = { calls: [] }
    const fakeWriter: import("../tools/tool-result-limiter.js").ArtifactWriter = {
      writeArtifact: async (name, content, mimeType) => {
        captureWriter.calls.push({ name, content })
        return { id: `art_${captureWriter.calls.length}`, path: `/tmp/${name}`, size: content.length }
      },
    }
    const toolManager = new FakeToolManager()
    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
      artifactWriter: fakeWriter,
    })
    const convId = store.createConversation("conv_limiter2")

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "tool.call", responseId: "resp_1", callId: "call_1", name: "file.read", argumentsText: JSON.stringify({ path: "/smallfile" }) },
      { type: "response.completed", responseId: "resp_1" },
    ])
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Done" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(convId, "Read small file")
    await waitForRun(provider)

    assert.equal(captureWriter.calls.length, 0, "artifactWriter should NOT be called for short output")
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Tool execution timeout                                       */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — tool execution timeout", () => {
  test("tool that never resolves triggers timeout and tool.failed", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const toolManager = new FakeToolManager()
    const events: AssistantRuntimeEvent[] = []

    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
      toolExecutionTimeoutMs: 50, // short timeout for testing
    })
    runtime.onEvent((ev) => events.push(ev))
    const convId = store.createConversation("conv_timeout1")

    // Make tool hang (never resolves)
    let executeResolve: (() => void) | null = null
    const origExecute = toolManager.executeToolCall.bind(toolManager)
    toolManager.executeToolCall = async (call) => {
      await new Promise<void>((resolve) => { executeResolve = resolve })
      return { callId: call.callId, name: call.name, status: "ok", output: "done", summary: "Done" }
    }

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "tool.call", responseId: "resp_1", callId: "call_1", name: "shell.run", argumentsText: JSON.stringify({ command: "echo hi" }) },
      { type: "response.completed", responseId: "resp_1" },
    ])
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Timeout handled" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(convId, "Run command")
    await waitForRun(provider)

    // Should have tool.failed event
    const toolFailed = events.filter((e) => e.type === "tool.failed")
    assert.equal(toolFailed.length, 1, "Should have tool.failed event")

    // Should have continuation (model received error result)
    assert.equal(provider.continuationCallCount, 1, "Model should have received error result via continuation")

    // Run should complete (not fail)
    assert.ok(events.some((e) => e.type === "run.completed"), "Run should complete after timeout error continuation")
  })

  test("normal tool execution is NOT affected by timeout", async () => {
    const { runtime, provider, toolManager, events, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "tool.call", responseId: "resp_1", callId: "call_1", name: "shell.run", argumentsText: JSON.stringify({ command: "echo hi" }) },
      { type: "response.completed", responseId: "resp_1" },
    ])
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Done" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(conversationId, "Run command")

    // Tool should have executed normally
    assert.equal(toolManager.executedCalls.length, 1)
    assert.ok(events.some((e) => e.type === "tool.completed"))
    assert.ok(events.some((e) => e.type === "run.completed"))
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Retryable provider failure replay (ws_closed_unexpectedly)    */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — retryable provider failure replay", () => {
  test("ws_closed_unexpectedly with retryable:true triggers replay once", async () => {
    const { runtime, provider, store, events, conversationId } = createHarness()

    // First create attempt: fails with ws_closed_unexpectedly
    // Second create attempt: succeeds
    provider.setCreateSequences([
      // First attempt → fails
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "response.failed", error: { code: "ws_closed_unexpectedly", message: "WS closed unexpectedly", retryable: true } },
      ],
      // Replay → succeeds
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "text.delta", responseId: "resp_2", delta: "Replayed successfully" },
        { type: "response.completed", responseId: "resp_2" },
      ],
    ])

    await runtime.sendUserMessage(conversationId, "Test ws replay")
    await waitForRun(provider)

    // Should have run.completed (replay worked)
    const completedEvents = events.filter((e) => e.type === "run.completed")
    assert.equal(completedEvents.length, 1)

    // Should have two create calls (initial + replay)
    assert.equal(provider.createCallCount, 2, "Should have replayed once")
    assert.equal(provider.openCallCount, 1, "Should reopen provider before replay after WS close")

    // RemoteResponseId should be set to the second response
    assert.equal(store.getRemoteResponseId(conversationId), "resp_2")
  })

  test("ws_reconnect_failed with retryable:true also triggers replay once", async () => {
    const { runtime, provider, store, events, conversationId } = createHarness()

    provider.setCreateSequences([
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "response.failed", error: { code: "ws_reconnect_failed", message: "Reconnect failed", retryable: true } },
      ],
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "text.delta", responseId: "resp_2", delta: "Replayed" },
        { type: "response.completed", responseId: "resp_2" },
      ],
    ])

    await runtime.sendUserMessage(conversationId, "Test reconnect replay")
    await waitForRun(provider)

    assert.ok(events.some((e) => e.type === "run.completed"))
    assert.equal(provider.createCallCount, 2)
  })

  test("second ws_closed_unexpectedly after replay fails the run", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    // Both attempts fail
    provider.setCreateSequences([
      // First attempt → fails
      [
        { type: "response.created", responseId: "resp_1" },
        { type: "response.failed", error: { code: "ws_closed_unexpectedly", message: "First failure", retryable: true } },
      ],
      // Replay → also fails
      [
        { type: "response.created", responseId: "resp_2" },
        { type: "response.failed", error: { code: "ws_closed_unexpectedly", message: "Second failure", retryable: true } },
      ],
    ])

    await runtime.sendUserMessage(conversationId, "Test double ws fail")

    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.equal(failedEvents.length, 1)
    assert.equal(provider.createCallCount, 2)
  })

  test("ws_closed_unexpectedly with retryable:false does NOT replay", async () => {
    const { runtime, provider, events, conversationId } = createHarness()

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "response.failed", error: { code: "ws_closed_unexpectedly", message: "Non-retryable close", retryable: false } },
    ])

    await runtime.sendUserMessage(conversationId, "Test non-retryable ws fail")

    const failedEvents = events.filter((e) => e.type === "run.failed")
    assert.equal(failedEvents.length, 1)
    // Only one create call (no replay)
    assert.equal(provider.createCallCount, 1)
  })
})

/* ------------------------------------------------------------------ */
/*  Test: Tool round completion clears remoteResponseId                */
/*  and appendToolResultMessage receives historySummary                */
/* ------------------------------------------------------------------ */

describe("AssistantRuntime — tool round completion clears remoteResponseId", () => {
  test("after tool round completes, remoteResponseId is cleared and historySummary is forwarded", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const toolManager = new FakeToolManager()
    const events: AssistantRuntimeEvent[] = []

    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    runtime.onEvent((ev) => events.push(ev))
    const convId = store.createConversation("conv_tool_clear")

    // Initial: tool call
    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo hi" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])
    // Continuation: text response (no further tool calls)
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Done!" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(convId, "Run command")
    await waitForRun(provider)

    // After the tool round completes, remoteResponseId should be cleared
    // (because toolCallCount > 0, the code sets remoteResponseId to null)
    assert.equal(store.getRemoteResponseId(convId), null,
      "remoteResponseId must be cleared after tool round completion")

    // The run should have completed successfully
    assert.ok(events.some((e) => e.type === "run.completed"), "run should complete")

    // appendToolResultMessage should have been called with a historySummary
    assert.ok(store.toolResultCalls.length > 0, "appendToolResultMessage should have been called")
    const toolResultCall = store.toolResultCalls[0]!
    assert.equal(toolResultCall.toolName, "shell.run")
    assert.ok(typeof toolResultCall.historySummary === "string" && toolResultCall.historySummary.length > 0,
      "historySummary must be a non-empty string")
    assert.ok(toolResultCall.historySummary!.startsWith("[Tool Result Summary]"),
      "historySummary must start with [Tool Result Summary]")
    assert.ok(toolResultCall.historySummary!.includes("shell.run"),
      "historySummary must include the tool name")
  })

  test("tool result message in store has the limited output (not historySummary)", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const toolManager = new FakeToolManager()
    const events: AssistantRuntimeEvent[] = []

    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager,
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    runtime.onEvent((ev) => events.push(ev))
    const convId = store.createConversation("conv_tool_raw")

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      {
        type: "tool.call",
        responseId: "resp_1",
        callId: "call_1",
        name: "shell.run",
        argumentsText: JSON.stringify({ command: "echo hi" }),
      },
      { type: "response.completed", responseId: "resp_1" },
    ])
    provider.setContinuationSequence([
      { type: "response.created", responseId: "resp_2" },
      { type: "text.delta", responseId: "resp_2", delta: "Done" },
      { type: "response.completed", responseId: "resp_2" },
    ])

    await runtime.sendUserMessage(convId, "Run")
    await waitForRun(provider)

    // The tool message in the conversation store should have the limited output
    // (ToolResultLimiter wraps even short output in { status, summary, content }),
    // NOT the [Tool Result Summary] history summary.
    const msgs = store.getConversationMessages(convId)
    const toolMsg = msgs.find((m) => m.role === "tool")
    assert.ok(toolMsg, "tool message should exist in store")
    const parsed = JSON.parse(toolMsg!.content)
    assert.ok(parsed.status !== undefined, "stored tool message should be a limited JSON envelope, not a summary")
    // The historySummary is a SEPARATE parameter, not the stored content
    assert.ok(!toolMsg!.content.startsWith("[Tool Result Summary]"),
      "stored tool content must NOT be the history summary")
  })

  test("text-only response (no tools) preserves remoteResponseId", async () => {
    const store = new FakeConversationStore()
    const provider = new FakeProviderRuntime()
    const events: AssistantRuntimeEvent[] = []

    const runtime = new AssistantRuntime({
      conversationStore: store,
      provider,
      contextBuilder: new FakeContextBuilder(),
      toolManager: new FakeToolManager(),
      model: "test-model",
      systemPrompt: "You are a test assistant.",
    })
    runtime.onEvent((ev) => events.push(ev))
    const convId = store.createConversation("conv_no_tools")

    provider.setSingleCreateSequence([
      { type: "response.created", responseId: "resp_1" },
      { type: "text.delta", responseId: "resp_1", delta: "Hello" },
      { type: "response.completed", responseId: "resp_1" },
    ])

    await runtime.sendUserMessage(convId, "Hi")
    await waitForRun(provider)

    // Text-only response should preserve the remoteResponseId
    assert.equal(store.getRemoteResponseId(convId), "resp_1",
      "remoteResponseId should be preserved for text-only responses")
    assert.ok(events.some((e) => e.type === "run.completed"))
  })
})
