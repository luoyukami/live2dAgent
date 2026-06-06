import type { AgentEvent } from "@live2d-agent/agent-core"

/**
 * AvatarDriver — abstract interface for Live2D model control.
 *
 * Implementations can use PixiJS, WebGL, or any other rendering approach.
 * The driver does NOT participate in agent decisions; it only reacts to
 * AgentEvent emissions from the agent core.
 */
export interface AvatarDriver {
  /** Load a Live2D model from the given file path. */
  load(modelPath: string): Promise<void>

  /** Set the model's facial expression by name (e.g. "angry", "smile"). */
  setExpression(name: string): Promise<void>

  /** Play a motion from a motion group (e.g. "tap_body", "idle"). */
  playMotion(group: string, index?: number): Promise<void>

  /** Set lip-sync value (0–1). No-op in v0. */
  setLipSync(value: number): void

  /** Release all resources held by the driver. */
  dispose(): Promise<void>
}

/**
 * Mapped avatar states derived from AgentEvent.
 *
 * Mapping (from docs):
 *   agent.idle              → idle
 *   agent.thinking          → thinking
 *   approval.pending        → waiting_approval
 *   tool.started            → running_tool
 *   tool.finished (ok=true) → success
 *   tool.error              → error
 *   agent.error             → error
 */
export type AvatarState =
  | "idle"
  | "thinking"
  | "waiting_approval"
  | "running_tool"
  | "success"
  | "error"

/**
 * Convert an AgentEvent into the corresponding AvatarState.
 * Returns null for events that should NOT trigger a state change.
 */
export function mapEventToState(event: AgentEvent): AvatarState | null {
  switch (event.type) {
    case "agent.idle":
      return "idle"
    case "agent.thinking":
      return "thinking"
    case "approval.pending":
      return "waiting_approval"
    case "tool.started":
      return "running_tool"
    case "tool.finished":
      return event.result.ok ? "success" : "error"
    case "tool.error":
      return "error"
    case "agent.error":
      return "error"
    /* Non-visual events — no state transition */
    case "message.added":
    case "approval.approved":
    case "approval.denied":
    case "settings.updated":
    case "emotion.set":
      return null
  }
}
