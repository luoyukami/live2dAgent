import { DEFAULT_PERMISSION_POLICY } from "@live2d-agent/shared"
import type { PermissionLevel } from "@live2d-agent/shared"
import type { AgentAction, AgentEvent, PermissionController, ToolDefinition } from "@live2d-agent/agent-core"
import type { SettingsService } from "./settings-service.js"

interface PendingRequest {
  actions: AgentAction[]
  requiresApproval: AgentAction[]
  resolve: (decision: { status: "approved" | "denied"; actions: AgentAction[]; reason?: string }) => void
}

export class PermissionService implements PermissionController {
  private pending?: PendingRequest
  private toolDefinitions = new Map<string, ToolDefinition>()
  private approvedOnce = new Set<string>()
  private pendingListener?: (payload: { event: AgentEvent }) => void
  private lastDecision?: unknown

  constructor(private readonly settings: SettingsService) {}

  setToolDefinitions(definitions: ToolDefinition[]): void {
    this.toolDefinitions = new Map(definitions.map((definition) => [definition.name, definition]))
  }

  onPending(listener: (payload: { event: AgentEvent }) => void): void {
    this.pendingListener = listener
  }

  async check(actions: AgentAction[]): Promise<{ status: "approved" | "denied"; actions: AgentAction[]; reason?: string }> {
    const mode = this.settings.get().mode
    if (mode === "manual") {
      if (actions.every((action) => action.source === "user")) {
        return this.requestApproval(actions, actions)
      }
      const decision = { status: "denied" as const, actions, reason: "manual mode blocks tool execution" }
      this.lastDecision = decision
      return decision
    }

    const denied = actions.filter((action) => this.policyForAction(action) === "deny")
    if (denied.length > 0) {
      const decision = { status: "denied" as const, actions: denied, reason: "tool permission policy denied execution" }
      this.lastDecision = decision
      return decision
    }

    const requiresApproval = actions.filter((action) => !this.canAutoApprove(action))
    if (requiresApproval.length === 0) {
      const decision = { status: "approved" as const, actions }
      this.lastDecision = decision
      return decision
    }

    return this.requestApproval(actions, requiresApproval)
  }

  getLastDecision(): unknown {
    return this.lastDecision
  }

  resetSessionState(reason = "context cleared"): void {
    this.approvedOnce.clear()
    if (!this.pending) return
    const actionIds = this.pending.requiresApproval.map((action) => action.id)
    this.pending.resolve({
      status: "denied",
      actions: this.pending.requiresApproval,
      reason,
    })
    this.pendingListener?.({ event: { type: "approval.denied", actionIds, reason } })
    this.pending = undefined
  }

  private requestApproval(
    actions: AgentAction[],
    requiresApproval: AgentAction[],
  ): Promise<{ status: "approved" | "denied"; actions: AgentAction[]; reason?: string }> {
    this.pendingListener?.({ event: { type: "approval.pending", actions: requiresApproval } })
    return new Promise((resolve) => {
      this.pending = { actions, requiresApproval, resolve: (decision) => {
        this.lastDecision = decision
        resolve(decision)
      } }
    })
  }

  approve(actionId: string): void {
    if (!this.pending) return
    const action = this.pending.requiresApproval.find((item) => item.id === actionId)
    if (!action) return
    this.approvedOnce.add(action.tool)
    this.pendingListener?.({ event: { type: "approval.approved", actionIds: [actionId] } })
    const autoApproved = this.pending.actions.filter((item) => item.id !== action.id && this.canAutoApprove(item))
    this.pending.resolve({ status: "approved", actions: [...autoApproved, action] })
    this.pending = undefined
  }

  deny(actionId: string, reason?: string): void {
    if (!this.pending) return
    const denied = this.pending.actions.find((action) => action.id === actionId)
    this.pending.resolve({
      status: "denied",
      actions: denied ? [denied] : this.pending.actions,
      reason,
    })
    this.pendingListener?.({ event: { type: "approval.denied", actionIds: [actionId], reason } })
    this.pending = undefined
  }

  private canAutoApprove(action: AgentAction): boolean {
    const policy = this.policyForAction(action)
    return policy === "auto" || (policy === "confirm_once_per_session" && this.approvedOnce.has(action.tool))
  }

  private policyForAction(action: AgentAction): string {
    const permission = this.toolDefinitions.get(action.tool)?.permission ?? "dangerous"
    return this.policyFor(permission, action)
  }

  private policyFor(permission: PermissionLevel, action: AgentAction): string {
    if (isHighImpactMcpTool(action.tool)) return "confirm_each"
    if (this.settings.get().permissions.mode !== "permissive") return DEFAULT_PERMISSION_POLICY[permission]

    if (permission === "dangerous") return "deny"
    if (permission === "shell" && isHighImpactShellCommand(action.args)) return "confirm_each"
    return "auto"
  }
}

function isHighImpactMcpTool(toolName: string): boolean {
  return /^mcp__/.test(toolName) && /__(?:delete|remove|write|update|create|exec|shell|command|run|spawn|apply|mutate)/i.test(toolName)
}

function isHighImpactShellCommand(args: unknown): boolean {
  const command = String((args && typeof args === "object" ? (args as Record<string, unknown>).command : "") ?? "")
    .toLowerCase()
    .replace(/`\s*/g, "")

  const destructivePatterns = [
    /\bremove-item\b[^\n;|&]*\s-(?:recurse|r)\b[^\n;|&]*\s-(?:force|f)\b/,
    /\brm\b[^\n;|&]*\s-rf\b/,
    /\brmdir\b[^\n;|&]*\s\/s\b/,
    /\bdel\b[^\n;|&]*\s[/*]/,
    /\bformat\b\s+[a-z]:/,
    /\bdiskpart\b/,
    /\btaskkill\b[^\n;|&]*\s\/f\b/,
    /\breg\b\s+(?:delete|add)\b/,
    /\bset-executionpolicy\b/,
    /\bnew-localuser\b|\bremove-localuser\b/,
    /\bnet\b\s+user\b/,
    /\bchmod\b\s+-r\b/,
    /\bchown\b\s+-r\b/,
    />\s*(?:\$profile|~\/\.\w+|[a-z]:\\windows\\)/,
  ]

  return destructivePatterns.some((pattern) => pattern.test(command))
}
