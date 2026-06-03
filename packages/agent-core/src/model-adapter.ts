import type { AgentMessage, ToolDefinition, ToolResult } from "./types.js"

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
   */
  query(input: {
    messages: AgentMessage[]
    tools: ToolDefinition[]
  }): Promise<AgentMessage>

  /**
   * Transform tool execution results into observation messages that can be
   * fed back into the conversation history.
   */
  formatObservations(results: ToolResult[]): AgentMessage[]
}
