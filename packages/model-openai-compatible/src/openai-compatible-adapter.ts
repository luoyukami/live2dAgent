import type {
  ModelAdapter,
  AgentMessage,
  ToolDefinition,
  ToolResult,
  AgentAction,
} from "@live2d-agent/agent-core"

/**
 * Configuration for an OpenAI-compatible Chat Completions endpoint.
 */
export interface OpenAiCompatibleAdapterConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * Adapter that talks to any OpenAI-compatible /chat/completions endpoint
 * using the built-in `fetch` API (no Node / Electron dependency).
 *
 * Supports:
 *  - Text responses (content string)
 *  - Tool / function calling (converted to AgentAction[])
 *  - Error recovery via message.extra.rawResponse
 */
export class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(private config: OpenAiCompatibleAdapterConfig) {}

  /* ---- ModelAdapter.query ---- */

  async query(input: {
    messages: AgentMessage[]
    tools: ToolDefinition[]
  }): Promise<AgentMessage> {
    const body = this.buildRequestBody(input.messages, input.tools)

    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return this.errorMessage(`Network error: ${message}`, { recoverable: true })
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      return this.errorMessage(
        `API error ${response.status} ${response.statusText}: ${errorText}`,
        { code: "API_ERROR", message: errorText, recoverable: true },
      )
    }

    let json: Record<string, unknown>
    try {
      json = (await response.json()) as Record<string, unknown>
    } catch {
      return this.errorMessage("Invalid JSON response from model API", {
        recoverable: true,
      })
    }

    const choices = json.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) {
      return this.errorMessage("Model returned empty response (no choices)", {
        rawResponse: json,
        code: "EMPTY_RESPONSE",
        message: "No choices in response",
        recoverable: true,
      })
    }

    const message = choice.message as Record<string, unknown> | undefined
    if (!message) {
      return this.errorMessage("Model returned empty message", {
        rawResponse: json,
        recoverable: true,
      })
    }

    /* ---- Extract tool calls ---- */
    const actions: AgentAction[] = []
    const rawToolCalls = message.tool_calls as
      | Array<Record<string, unknown>>
      | undefined

    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined
        let parsedArgs: unknown
        try {
          parsedArgs = JSON.parse((fn?.arguments as string) ?? "{}")
        } catch {
          parsedArgs = { _parseError: fn?.arguments ?? "missing arguments" }
        }

        actions.push({
          id: `act_${tc.id as string}`,
          tool: (fn?.name as string) ?? "unknown",
          args: parsedArgs,
          source: "llm",
          createdAt: Date.now(),
        })
      }
    }

    const content: string =
      typeof message.content === "string" ? message.content : ""

    return {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      role: "assistant",
      content,
      actions: actions.length > 0 ? actions : undefined,
      createdAt: Date.now(),
      extra: { rawResponse: json },
    }
  }

  /* ---- ModelAdapter.formatObservations ---- */

  formatObservations(results: ToolResult[]): AgentMessage[] {
    return results.map((result) => ({
      id: `obs_${result.actionId}`,
      role: "tool",
      content: this.formatObservationText(result),
      toolCallId: result.actionId,
      createdAt: result.endedAt,
      extra: {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      },
    }))
  }

  /* ---- private helpers ---- */

  private formatObservationText(result: ToolResult): string {
    if (!result.ok) {
      return `Error executing ${result.tool}: ${result.error?.message ?? result.content}`
    }
    return result.content
  }

  private buildRequestBody(
    messages: AgentMessage[],
    tools: ToolDefinition[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.formatMessage(m)),
    }

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    }

    return body
  }

  private formatMessage(message: AgentMessage): Record<string, unknown> {
    const msg: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    }

    if (message.toolCallId) {
      msg.tool_call_id = message.toolCallId
    }

    if (message.actions && message.role === "assistant") {
      msg.tool_calls = message.actions.map((a) => ({
        id: a.id,
        type: "function",
        function: {
          name: a.tool,
          arguments: JSON.stringify(a.args),
        },
      }))
    }

    return msg
  }

  private errorMessage(
    text: string,
    extra?: Record<string, unknown>,
  ): AgentMessage {
    return {
      id: `msg_error_${Date.now()}`,
      role: "assistant",
      content: text,
      createdAt: Date.now(),
      extra: { rawResponse: null, error: { code: "MODEL_ERROR", message: text, recoverable: true }, ...extra },
    }
  }
}
