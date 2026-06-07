import type {
  ModelWsCreateResponseInput,
  ModelWsSessionInit,
  ModelWsToolResultInput,
  ModelWsCancelInput,
  ModelWsCloseInput,
  ModelWsEvent,
  WsToolCall,
} from "@live2d-agent/agent-core"

/**
 * Outbound messages for the OpenAI Responses WebSocket protocol.
 *
 * Reference: https://platform.openai.com/docs/api-reference/responses
 *
 * Key differences from the previous custom protocol:
 *  - No session.init — model/instructions are per-response.
 *  - Tool results are not sent as separate messages; they are included as
 *    function_call_output items in the next response.create's `input`.
 *  - response.create includes model, store, previous_response_id, input, and tools.
 *  - API key is passed via constructor options (headers), not in the URL.
 */
export type OpenAiCompatibleWsOutboundMessage =
  | {
      type: "response.create"
      model?: string
      store?: boolean
      previous_response_id?: string | null
      input?: unknown[]
      tools?: unknown[]
    }
  | { type: "response.cancel"; response_id: string }
  | { type: "ping" }

export interface OpenAiCompatibleWsProtocol {
  encode(message: OpenAiCompatibleWsOutboundMessage): string
  decode(raw: string): ModelWsEvent | null
}

export class JsonModelWsProtocol implements OpenAiCompatibleWsProtocol {
  encode(message: OpenAiCompatibleWsOutboundMessage): string {
    return JSON.stringify(message)
  }

  decode(raw: string): ModelWsEvent | null {
    const payload = parseJsonObject(raw)
    if (!payload) return null

    const type = String(payload.type ?? "")

    switch (type) {
      case "connected":
        return { type: "connected" }
      case "session.ready":
      case "session.created":
      case "session.updated":
        return { type: "session.ready", remoteSessionId: stringOrUndefined(payload.remoteSessionId ?? payload.session_id ?? payload.id) }
      case "response.created":
        return {
          type: "response.created",
          responseId: stringValue(payload.responseId ?? payload.response_id ?? payload.id),
          remoteContextId: stringOrUndefined(payload.remoteContextId ?? payload.previous_response_id ?? payload.context_id),
        }
      case "response.text.delta":
      case "response.output_text.delta":
        return {
          type: "response.text.delta",
          responseId: stringValue(payload.responseId ?? payload.response_id ?? payload.response?.id),
          delta: stringValue(payload.delta ?? payload.text),
        }
      case "response.tool_call.created":
      case "response.function_call_arguments.done":
        return this.decodeToolCall(payload)
      case "response.completed":
      case "response.done":
        return {
          type: "response.completed",
          responseId: stringValue(payload.responseId ?? payload.response_id ?? payload.response?.id),
          remoteContextId: stringOrUndefined(payload.remoteContextId ?? payload.previous_response_id ?? payload.context_id ?? payload.response?.id),
        }
      case "response.cancelled":
        return { type: "response.cancelled", responseId: stringValue(payload.responseId ?? payload.response_id ?? payload.response?.id) }
      case "pong":
        return { type: "pong" }
      case "error":
        return {
          type: "error",
          error: {
            code: stringValue(payload.code ?? payload.error?.code ?? "ws_protocol_error"),
            message: stringValue(payload.message ?? payload.error?.message ?? "Model WebSocket error"),
            retryable: Boolean(payload.retryable ?? true),
            cause: payload,
          },
        }
      default:
        return null
    }
  }

  private decodeToolCall(payload: Record<string, any>): ModelWsEvent | null {
    const toolCallPayload = payload.toolCall ?? payload.tool_call ?? payload
    const args = toolCallPayload.arguments ?? toolCallPayload.args ?? payload.arguments
    const toolCall: WsToolCall = {
      id: stringValue(toolCallPayload.id ?? toolCallPayload.call_id ?? payload.call_id),
      name: stringValue(toolCallPayload.name ?? toolCallPayload.function?.name ?? payload.name),
      arguments: typeof args === "string" ? parseJsonObject(args) ?? args : args,
    }

    return {
      type: "response.tool_call.created",
      responseId: stringValue(payload.responseId ?? payload.response_id ?? payload.response?.id),
      toolCall,
    }
  }
}

function parseJsonObject(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = stringValue(value)
  return text.length > 0 ? text : undefined
}
