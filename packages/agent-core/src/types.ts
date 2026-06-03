import type {
  ToolName,
  PermissionLevel,
  AgentMode,
  ToolArtifact,
  MultimodalContent,
} from "@live2d-agent/shared"

/* ---- Re-export shared types that are part of the core domain ---- */
export type { ToolName, PermissionLevel, AgentMode, ToolArtifact, MultimodalContent }

/* ---- Agent Message ---- */
export interface AgentMessage {
  id: string
  role: "system" | "user" | "assistant" | "tool"
  content: string | MultimodalContent[]
  /** Tool calls proposed by the model (only on assistant messages) */
  actions?: AgentAction[]
  /** Links a tool-role observation back to the originating call */
  toolCallId?: string
  createdAt: number
  extra?: Record<string, unknown>
}

/* ---- Agent Action (tool invocation) ---- */
export interface AgentAction {
  id: string
  /** Provider-specific tool call id, e.g. OpenAI `call_xxx`. */
  providerToolCallId?: string
  tool: ToolName
  args: unknown
  source: "llm" | "user" | "system"
  createdAt: number
}

/* ---- Tool Execution Result ---- */
export interface ToolResult {
  actionId: string
  /** Provider-specific tool call id copied from the originating action. */
  providerToolCallId?: string
  tool: ToolName
  ok: boolean
  content: string
  data?: unknown
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
  artifacts?: ToolArtifact[]
  startedAt: number
  endedAt: number
}

/* ---- Tool Definition (exposed to the model) ---- */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  permission: PermissionLevel
}

/* ---- Agent Event (observable by renderer / Live2D) ---- */
export type AgentEvent =
  | { type: "agent.idle" }
  | { type: "agent.thinking" }
  | { type: "message.added"; message: AgentMessage }
  | { type: "approval.pending"; actions: AgentAction[] }
  | { type: "approval.approved"; actionIds: string[] }
  | { type: "approval.denied"; actionIds: string[]; reason?: string }
  | { type: "tool.started"; action: AgentAction }
  | { type: "tool.finished"; result: ToolResult }
  | { type: "tool.error"; result: ToolResult }
  | { type: "agent.error"; error: string }

/* ---- Callback & subscription types ---- */
export type AgentEventCallback = (event: AgentEvent) => void
export type Unsubscribe = () => void
