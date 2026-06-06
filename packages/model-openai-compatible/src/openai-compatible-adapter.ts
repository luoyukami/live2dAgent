import type {
  ModelAdapter,
  AgentMessage,
  ToolDefinition,
  ToolResult,
  AgentAction,
  ToolArtifact,
  ArtifactRef,
  MultimodalContent,
} from "@live2d-agent/agent-core"

/**
 * Configuration for an OpenAI-compatible Chat Completions endpoint.
 */
export interface OpenAiCompatibleAdapterConfig {
  baseUrl: string
  apiKey: string
  model: string
  artifactReader?: ArtifactReader
  systemPromptProvider?: () => string | undefined
  onModelRequest?: (request: unknown) => void
  onModelResponse?: (response: unknown) => void
  /** When true the adapter converts audio attachments to `input_audio` content parts. */
  audioInputEnabled?: boolean
  /** Provides raw audio bytes for a stored audio artifact reference. */
  audioReader?: {
    readAudio(ref: ArtifactRef): Uint8Array
  }
  /**
   * Fired for every audio attachment that is actually included in the
   * outgoing request. Used by the agent service to record a
   * `audio.sent_to_model` trace event.
   */
  onAudioSent?: (info: {
    attachmentId: string
    format: "wav" | "mp3"
    durationMs: number
    bytes: number
  }) => void
}

export interface ArtifactReader {
  readArtifact(ref: ArtifactRef): Uint8Array
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
    this.config.onModelRequest?.(this.redactRequest(body))

    let response: Response
    try {
      response = await fetch(this.chatCompletionsUrl(), {
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
      this.config.onModelResponse?.({ status: response.status, statusText: response.statusText, error: errorText })
      const isImageUnsupported = /image|vision|multimodal|unsupported/i.test(errorText)
      const userMessage = isImageUnsupported
        ? "当前模型可能不支持图像输入，请切换到支持视觉的模型。"
        : `API error ${response.status} ${response.statusText}: ${errorText}`
      return this.errorMessage(
        userMessage,
        { code: "API_ERROR", message: errorText, recoverable: true },
      )
    }

    let json: Record<string, unknown>
    try {
      json = (await response.json()) as Record<string, unknown>
      this.config.onModelResponse?.(json)
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
          providerToolCallId: tc.id as string,
          tool: this.fromProviderToolName((fn?.name as string) ?? "unknown"),
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
    return results.flatMap((result) => {
      const observation: AgentMessage = {
        id: `obs_${result.actionId}`,
        role: "tool",
        content: this.formatObservationText(result),
        toolCallId: result.providerToolCallId ?? result.actionId,
        createdAt: result.endedAt,
        extra: {
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        },
      }

      const imageMessage = this.formatScreenshotImageMessage(result)
      return imageMessage ? [observation, imageMessage] : [observation]
    })
  }

  /* ---- private helpers ---- */

  private chatCompletionsUrl(): string {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "")
    return /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`
  }

  private formatScreenshotImageMessage(result: ToolResult): AgentMessage | undefined {
    if (result.tool === "screenshot.capture" && result.ok) {
      const artifact = this.findImageArtifact(result)
      if (artifact) {
        return {
          id: `img_${result.actionId}`,
          role: "user",
          content: [
            { type: "text", text: "Screenshot image for the preceding screenshot.capture result." },
            {
              type: "image_url",
              image_url: {
                url: artifact.dataUrl,
                detail: "auto",
              },
            },
          ],
          createdAt: result.endedAt,
          extra: { type: "tool_artifact", actionId: result.actionId, tool: result.tool },
        }
      }
    }

    return undefined
  }

  /**
   * Find the first image artifact from a ToolResult.
   * Tries result.artifacts first, then falls back to result.data.artifact,
   * then falls back to legacy result.data.imageBase64.
   * Returns { dataUrl, mimeType } or undefined.
   */
  private findImageArtifact(result: ToolResult): { dataUrl: string; mimeType: string } | undefined {
    /* ---- Try structured artifacts array ---- */
    if (result.artifacts && result.artifacts.length > 0) {
      for (const ta of result.artifacts) {
        if (ta.type === "screenshot" || ta.mimeType?.startsWith("image/")) {
          const ref = this.extractRef(ta)
          if (ref) {
            const dataUrl = this.readArtifactAsDataUrl(ref)
            if (dataUrl) return { dataUrl, mimeType: ref.mimeType }
          }
        }
      }
    }

    /* ---- Try result.data.artifact (ref embedded in data) ---- */
    const data = result.data as Record<string, unknown> | undefined
    if (data?.artifact && typeof data.artifact === "object") {
      const ref = data.artifact as ArtifactRef
      const dataUrl = this.readArtifactAsDataUrl(ref)
      if (dataUrl) return { dataUrl, mimeType: ref.mimeType }
    }

    /* ---- Legacy fallback: result.data.imageBase64 ---- */
    if (typeof (data as { imageBase64?: unknown } | undefined)?.imageBase64 === "string") {
      const legacyData = data as { imageBase64: string; mimeType?: string }
      const mimeType = legacyData.mimeType ?? "image/png"
      return { dataUrl: `data:${mimeType};base64,${legacyData.imageBase64}`, mimeType }
    }

    return undefined
  }

  /**
   * Extract an ArtifactRef from a ToolArtifact (either from `artifact` field or via `path`).
   */
  private extractRef(ta: ToolArtifact): ArtifactRef | undefined {
    if (ta.artifact) return ta.artifact
    if (ta.path && ta.mimeType) {
      return {
        id: ta.id,
        kind: "screenshot",
        path: ta.path,
        mimeType: ta.mimeType,
        size: 0,
        createdAt: Date.now(),
      }
    }
    return undefined
  }

  /**
   * Read an artifact file from disk and return a data URL.
   * Returns undefined on any error (file not found, read error, etc.).
   */
  private readArtifactAsDataUrl(ref: ArtifactRef): string | undefined {
    try {
      if (!this.config.artifactReader) return undefined
      const buffer = this.config.artifactReader.readArtifact(ref)
      const base64 = Buffer.from(buffer).toString("base64")
      return `data:${ref.mimeType};base64,${base64}`
    } catch {
      return undefined
    }
  }

  private formatObservationText(result: ToolResult): string {
    if (!result.ok) {
      return this.truncateObservation(`Error executing ${result.tool}: ${result.error?.message ?? result.content}`)
    }
    return this.truncateObservation(result.content)
  }

  private buildRequestBody(
    messages: AgentMessage[],
    tools: ToolDefinition[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.withSystemPrompt(messages).map((m) => this.formatMessage(m)),
    }

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: this.toProviderToolName(t.name),
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    }

    return body
  }

  private withSystemPrompt(messages: AgentMessage[]): AgentMessage[] {
    const systemPrompt = this.config.systemPromptProvider?.()?.trim()
    if (!systemPrompt) return messages
    return [
      {
        id: "system_dev_prompt",
        role: "system",
        content: systemPrompt,
        createdAt: Date.now(),
      },
      ...messages.filter((message) => message.role !== "system"),
    ]
  }

  private sanitiseDebugValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.sanitiseDebugValue(item))
    if (value && typeof value === "object") {
      // Redact input_audio.data — build a new object to avoid mutating the original.
      if ((value as Record<string, unknown>).type === "input_audio") {
        const obj = value as Record<string, unknown>
        const output: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(obj)) {
          if (key === "input_audio" && child && typeof child === "object") {
            // Redact the `data` field inside the nested input_audio object
            const audioObj = child as Record<string, unknown>
            const sanitized: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(audioObj)) {
              sanitized[k] = k === "data" ? "[omitted base64 data]" : v
            }
            output[key] = sanitized
          } else {
            output[key] = this.sanitiseDebugValue(child)
          }
        }
        return output
      }

      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (key === "url" && typeof child === "string" && child.startsWith("data:") && child.includes(";base64,")) {
          output[key] = "[omitted data url]"
        } else if (key === "imageBase64") {
          output[key] = "[omitted base64 data]"
        } else {
          output[key] = this.sanitiseDebugValue(child)
        }
      }
      return output
    }
    if (typeof value === "string") {
      if (value.startsWith("data:") && value.includes(";base64,")) return "[omitted data url]"
      if (value.length > 500 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) return "[omitted base64 data]"
    }
    return value
  }

  private formatMessage(message: AgentMessage): Record<string, unknown> {
    const msg: Record<string, unknown> = {
      role: message.role,
      content: this.expandUserMessage(message),
    }

    if (message.toolCallId) {
      msg.tool_call_id = message.toolCallId
    }

    if (message.actions && message.role === "assistant") {
      msg.tool_calls = message.actions.map((a) => ({
        id: a.providerToolCallId ?? a.id,
        type: "function",
        function: {
          name: this.toProviderToolName(a.tool),
          arguments: JSON.stringify(a.args),
        },
      }))
    }

    return msg
  }

  /**
   * Convert audio attachments on a user message into multimodal `input_audio`
   * content parts.  Returns the original content string when there are no
   * attachments, the message is not a user message, or audio input is disabled.
   *
   * @internal `buildRequestBodyForTest` exposes this path for unit testing.
   */
  private expandUserMessage(message: AgentMessage): string | MultimodalContent[] {
    if (
      message.role !== "user" ||
      !message.attachments ||
      message.attachments.length === 0 ||
      !this.config.audioInputEnabled
    ) {
      return message.content
    }

    const parts: MultimodalContent[] = []

    // Include existing text content first, if any.
    const text = typeof message.content === "string" ? message.content : ""
    if (text) {
      parts.push({ type: "text", text })
    }

    for (const attachment of message.attachments) {
      if (attachment.type !== "audio") continue
      if (!this.config.audioReader) continue

      const bytes = this.config.audioReader.readAudio(attachment.artifact)
      const base64 = Buffer.from(bytes).toString("base64")

      // Prefer "wav"; only use "mp3" when mime is audio/mpeg.
      const format: "wav" | "mp3" =
        attachment.mimeType === "audio/mpeg" ? "mp3" : "wav"

      parts.push({
        type: "input_audio",
        input_audio: { data: base64, format },
      })

      this.config.onAudioSent?.({
        attachmentId: attachment.id,
        format,
        durationMs: attachment.durationMs,
        bytes: bytes.byteLength,
      })
    }

    return parts.length > 0 ? parts : message.content
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

  private toProviderToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_")
  }

  private fromProviderToolName(name: string): string {
    const known: Record<string, string> = {
      shell_run: "shell.run",
      file_read: "file.read",
      file_write: "file.write",
      clipboard_read: "clipboard.read",
      clipboard_write: "clipboard.write",
      screenshot_capture: "screenshot.capture",
      task_finish: "task.finish",
    }
    return known[name] ?? name
  }

  private truncateObservation(content: string): string {
    const maxChars = 12_000
    const edgeChars = 6_000
    if (content.length <= maxChars) return content
    return `${content.slice(0, edgeChars)}\n\n[... truncated ${content.length - maxChars} chars ...]\n\n${content.slice(-edgeChars)}`
  }

  /**
   * Test-only helper that builds a request body without a network round-trip.
   * @internal — do not rely on this in production code.
   */
  buildRequestBodyForTest(
    messages: AgentMessage[],
    tools: ToolDefinition[],
  ): Record<string, unknown> {
    return this.buildRequestBody(messages, tools)
  }

  /**
   * Produce a sanitised copy of a request body safe for debug/tracing output.
   */
  redactRequest(body: Record<string, unknown>): Record<string, unknown> {
    return this.sanitiseDebugValue(body) as Record<string, unknown>
  }
}
