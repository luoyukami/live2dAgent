import type { AgentMessage, ToolDefinition, ToolResult } from "./types.js"

/**
 * Optional streaming callbacks passed to `ModelAdapter.query()`.
 *
 * When the adapter supports streaming, it will call `onTextDelta` for each
 * text chunk as it arrives. The adapter generates and owns the `messageId`
 * which is passed to every callback invocation so the caller can correlate
 * deltas to a specific response.
 *
 * If the adapter does not support streaming or streaming is not requested,
 * it will simply never call these callbacks and return the full message.
 */
export interface StreamingCallbacks {
  /**
   * Called for each text content delta during a streaming response.
   * @param messageId - Adapter-generated id for this response (stable across all deltas).
   * @param delta     - The incremental text content.
   */
  onTextDelta?(messageId: string, delta: string): void
}

/**
 * Abstraction over LLM providers.
 *
 * The only assumption is a Chat-Completions–like interface:
 *  - `query` returns an assistant message that MAY contain tool calls.
 *  - `formatObservations` converts execution results back into tool-role messages
 *     that can be appended to the conversation history.
 */
export interface ModelAdapter {
  /**
   * Send the current conversation (plus available tool definitions) to the model
   * and return the assistant's response message.
   *
   * When `callbacks` with `onTextDelta` is provided the adapter MAY choose to
   * stream the response, invoking the callback for each incremental text chunk
   * before the returned Promise resolves.
   */
  query(input: {
    messages: AgentMessage[]
    tools: ToolDefinition[]
    callbacks?: StreamingCallbacks
  }): Promise<AgentMessage>

  /**
   * Transform tool execution results into observation messages that can be
   * fed back into the conversation history.
   */
  formatObservations(results: ToolResult[]): AgentMessage[]
}
