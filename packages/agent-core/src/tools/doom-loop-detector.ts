/**
 * DoomLoopDetector — prevents same tool + args from repeating excessively.
 *
 * Rule (per run):
 *   - Consecutive identical tool+args are allowed up to `threshold` times.
 *   - The (threshold + 1)-th consecutive identical call is blocked.
 *   - Any different tool or different args resets the counter for that tool.
 *
 * "Identical args" means deep-strict equality of the parsed arguments object.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §9.7.
 */

import { WS_RUNTIME_CONSTANTS } from "../ws/ws-runtime-constants.js"

/* ------------------------------------------------------------------ */
/*  DoomLoopResult                                                     */
/* ------------------------------------------------------------------ */

export interface DoomLoopResult {
  /** Whether this call is allowed to proceed. */
  allowed: boolean
  /**
   * Explanation for the block. Present when `allowed` is false.
   */
  reason?: string
}

/* ------------------------------------------------------------------ */
/*  DoomLoopDetector                                                   */
/* ------------------------------------------------------------------ */

/**
 * Tracks tool call repetition within a single run.
 *
 * Usage:
 * ```ts
 * const detector = new DoomLoopDetector()
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: false, reason: "..." }
 * ```
 *
 * A call with different args resets the count for that tool:
 * ```ts
 * detector.check("file.read", { path: "/tmp/y" }) // { allowed: true } count=1 again
 * ```
 */
export class DoomLoopDetector {
  private readonly threshold: number
  /** Map: toolName → { argsKey → consecutiveCount } */
  private readonly callCounts = new Map<string, Map<string, number>>()

  constructor(threshold: number = WS_RUNTIME_CONSTANTS.DOOM_LOOP_THRESHOLD) {
    this.threshold = threshold
  }

  /**
   * Check whether a tool call should be allowed.
   *
   * @param toolName - Name of the tool being called.
   * @param args     - Parsed arguments object.
   * @returns DoomLoopResult with `allowed` flag.
   */
  check(toolName: string, args: Record<string, unknown>): DoomLoopResult {
    const argsKey = this.argsToKey(args)

    let toolCounts = this.callCounts.get(toolName)
    if (!toolCounts) {
      toolCounts = new Map()
      this.callCounts.set(toolName, toolCounts)
    }

    const currentCount = toolCounts.get(argsKey) ?? 0
    const newCount = currentCount + 1
    toolCounts.set(argsKey, newCount)

    if (newCount > this.threshold) {
      const blockedBy = newCount - 1 // the threshold count that was allowed
      return {
        allowed: false,
        reason: `Doom loop blocked: tool "${toolName}" called with identical arguments ${newCount} times consecutively (allowed ${blockedBy}, blocked #${newCount}). Use the previous result or change arguments.`,
      }
    }

    return { allowed: true }
  }

  /**
   * Reset all counters (e.g., at the start of a new run).
   */
  reset(): void {
    this.callCounts.clear()
  }

  /**
   * Convert arguments object to a stable string key for comparison.
   * Uses JSON.stringify with a replacer function that sorts keys
   * recursively for deterministic ordering regardless of key insertion order.
   */
  private argsToKey(args: Record<string, unknown>): string {
    return JSON.stringify(args, this.sortedKeyReplacer.bind(this))
  }

  /**
   * JSON.stringify replacer that outputs keys in sorted order
   * at every nesting level.
   */
  private sortedKeyReplacer(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k]
      }
      return sorted
    }
    return value
  }
}

/**
 * Build a doom-loop error output JSON string for the model.
 */
export function buildDoomLoopErrorOutput(
  toolName: string,
  reason: string,
): string {
  return JSON.stringify({
    status: "error",
    summary: "Repeated identical tool call blocked.",
    content: reason,
  })
}
