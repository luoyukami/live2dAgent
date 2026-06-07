/**
 * MiMo/OpenAI-Compatible WebSocket Protocol.
 *
 * Encodes provider requests (response.create, function_call_output) and
 * decodes provider frames into canonical ModelEvent objects.
 *
 * This module:
 *  - Does NOT establish WebSocket connections
 *  - Does NOT execute tools
 *  - Does NOT check permissions
 *  - Does NOT write message history
 *  - Does NOT trigger UI events
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §8
 */
import type { ModelEvent, TokenUsage } from "@live2d-agent/agent-core"
import type { ProviderToolSchema } from "./mimo-tool-schema-encoder.js"
import type { ModelMessage } from "@live2d-agent/agent-core"
import { encodeContent, type ProviderContentPart } from "./mimo-content-encoder.js"
import {
  decodeFrame,
  ToolCallArgumentAggregator,
} from "./mimo-event-decoder.js"

/* ------------------------------------------------------------------ */
/*  Re-export ModelEvent types                                         */
/* ------------------------------------------------------------------ */

export type { ModelEvent, TokenUsage } from "@live2d-agent/agent-core"

/* ------------------------------------------------------------------ */
/*  Outbound Message Types                                             */
/* ------------------------------------------------------------------ */

/**
 * outbound message for a response.create request.
 *
 * First request (no previous_response_id):
 * ```json
 * { "type": "response.create", "model": "...", "store": false,
 *   "input": [...], "tools": [...], "tool_choice": "auto",
 *   "parallel_tool_calls": false, "max_output_tokens": 8000 }
 * ```
 *
 * Continuation (with previous_response_id):
 * ```json
 * { "type": "response.create", "model": "...", "store": false,
 *   "previous_response_id": "...",
 *   "input": [ { "type": "function_call_output", "call_id": "...", "output": "..." } ],
 *   "tools": [...], "tool_choice": "auto",
 *   "parallel_tool_calls": false, "max_output_tokens": 8000 }
 * ```
 */
export interface MimoCreateRequest {
  type: "response.create"
  model: string
  store: false
  previous_response_id?: string | null
  input: ProviderInputItem[]
  tools: ProviderToolSchema[]
  tool_choice: "auto"
  parallel_tool_calls: false
  max_output_tokens: number
}

/**
 * An item in the `input` array of a response.create request.
 */
export type ProviderInputItem =
  | {
      type: "message"
      role: "system" | "user" | "assistant"
      content: ProviderContentPart[]
    }
  | { type: "function_call_output"; call_id: string; output: string }

/* ------------------------------------------------------------------ */
/*  MimoWsProtocol                                                     */
/* ------------------------------------------------------------------ */

export class MimoWsProtocol {
  private aggregator = new ToolCallArgumentAggregator()
  private currentResponseId: string | null = null

  /* ---- Accessors ---- */

  /** Get the current active response ID (set after decoding response.created). */
  get responseId(): string | null {
    return this.currentResponseId
  }

  /* ---- Encoding ---- */

  /**
   * Encode a first-time response.create request.
   *
   * @param model - Model identifier.
   * @param input - Array of provider input items (text, image, function_call_output).
   * @param tools - Provider-ready tool schemas.
   * @param maxOutputTokens - Maximum output tokens (default: 8000).
   * @returns The JSON-serialisable outbound message.
   */
  encodeCreateRequest(
    model: string,
    input: ProviderInputItem[],
    tools: ProviderToolSchema[],
    maxOutputTokens = 8_000,
    previousResponseId?: string | null,
  ): MimoCreateRequest {
    return {
      type: "response.create",
      model,
      store: false,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      input,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: maxOutputTokens,
    }
  }

  /** Encode canonical messages into provider message input items while preserving roles. */
  encodeMessages(messages: ModelMessage[]): ProviderInputItem[] {
    const items: ProviderInputItem[] = []
    for (const message of messages) {
      if (message.role === "tool") continue
      items.push({
        type: "message",
        role: message.role,
        content: encodeContent(message.content),
      })
    }
    return items
  }

  /**
   * Encode a continuation request with tool result and previous_response_id.
   *
   * @param model - Model identifier.
   * @param previousResponseId - The previous response ID for context continuation.
   * @param callId - The tool call ID being responded to.
   * @param output - The tool result output string.
   * @param tools - Provider-ready tool schemas.
   * @param maxOutputTokens - Maximum output tokens (default: 8000).
   * @returns The JSON-serialisable outbound message.
   */
  encodeContinuationRequest(
    model: string,
    previousResponseId: string,
    callId: string,
    output: string,
    tools: ProviderToolSchema[],
    maxOutputTokens = 8_000,
  ): MimoCreateRequest {
    return {
      type: "response.create",
      model,
      store: false,
      previous_response_id: previousResponseId,
      input: [
        {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      ],
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: maxOutputTokens,
    }
  }

  /* ---- Decoding ---- */

  /**
   * Decode a raw provider frame into zero or more ModelEvent objects.
   *
   * @param rawFrame - The raw parsed JSON frame from the provider WebSocket.
   * @returns Array of decoded ModelEvent objects.
   */
  decode(rawFrame: Record<string, unknown>): ModelEvent[] {
    const events = decodeFrame(rawFrame, this.aggregator, this.currentResponseId)

    // Track the current response ID after decoding
    for (const event of events) {
      if (event.type === "response.created") {
        this.currentResponseId = event.responseId
      } else if (
        event.type === "response.completed" ||
        event.type === "response.cancelled" ||
        event.type === "response.failed"
      ) {
        this.currentResponseId = null
      }
    }

    return events
  }

  /* ---- State Management ---- */

  /** Reset the protocol state (aggregator + response ID). */
  reset(): void {
    this.aggregator.fullReset()
    this.currentResponseId = null
  }
}
