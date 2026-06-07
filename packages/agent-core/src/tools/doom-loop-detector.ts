/**
 * DoomLoopDetector — prevents same tool + args from repeating excessively.
 *
 * Rule (per run):
 *   - Only consecutive identical tool+args are counted.
 *   - The first call is always allowed (count = 1).
 *   - Subsequent identical tool+args increment the count.
 *   - Any different tool OR different args **resets** the consecutive count to 1.
 *   - When count exceeds `threshold`, the call is blocked.
 *
 * "Identical args" means deep-strict equality of the parsed arguments object.
 *
 * This is a **truly consecutive** detector — A, B, A does NOT count
 * the second A as a continuation of the first A.
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
 * Tracks consecutive tool call repetition within a single run.
 *
 * Only **consecutive** same tool + same args increment the counter.
 * Any break (different tool or different args) resets back to 1.
 *
 * Usage:
 * ```ts
 * const detector = new DoomLoopDetector()
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=1
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=2
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=3
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: false, reason: "..." } count=4 >3
 *
 * // Non-consecutive (interleaved with different tool) resets:
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=1
 * detector.check("shell.run",  { command: "ls" }) // { allowed: true }  count=1 (different tool resets)
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=1 (resets again)
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=2
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=3
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: false } count=4 >3
 * ```
 *
 * Different args also reset:
 * ```ts
 * detector.check("file.read", { path: "/tmp/x" }) // { allowed: true }  count=1
 * detector.check("file.read", { path: "/tmp/y" }) // { allowed: true }  count=1 (different args reset)
 * ```
 */
export class DoomLoopDetector {
  private readonly threshold: number
  /** The last tool name seen — used to detect consecutive breaks. */
  private lastTool: string | null = null
  /** The last args key seen — used to detect consecutive breaks. */
  private lastArgsKey: string | null = null
  /** Current consecutive count for the (tool, args) pair above. */
  private count = 0

  constructor(threshold: number = WS_RUNTIME_CONSTANTS.DOOM_LOOP_THRESHOLD) {
    this.threshold = threshold
  }

  /**
   * Check whether a tool call should be allowed.
   *
   * Only increments the count when the new call matches both the
   * previous tool name AND the previous arguments.  Any mismatch
   * resets the consecutive count to 1.
   *
   * @param toolName - Name of the tool being called.
   * @param args     - Parsed arguments object.
   * @returns DoomLoopResult with `allowed` flag.
   */
  check(toolName: string, args: Record<string, unknown>): DoomLoopResult {
    const argsKey = this.argsToKey(args)

    // Consecutive same tool + same args → increment
    // Anything else → reset
    if (toolName === this.lastTool && argsKey === this.lastArgsKey) {
      this.count += 1
    } else {
      this.count = 1
      this.lastTool = toolName
      this.lastArgsKey = argsKey
    }

    if (this.count > this.threshold) {
      const blockedBy = this.threshold // the max allowed count
      return {
        allowed: false,
        reason: `Doom loop blocked: tool "${toolName}" called with identical arguments ${this.count} times consecutively (allowed ${blockedBy}, blocked #${this.count}). Use the previous result or change arguments.`,
      }
    }

    return { allowed: true }
  }

  /**
   * Reset all state (e.g., at the start of a new run).
   */
  reset(): void {
    this.lastTool = null
    this.lastArgsKey = null
    this.count = 0
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
