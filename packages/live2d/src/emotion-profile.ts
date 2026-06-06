import type { Emotion } from "@live2d-agent/shared"

/* ------------------------------------------------------------------ */
/*  Emotion → Live2D resource binding                                  */
/* ------------------------------------------------------------------ */

/**
 * One row of the per-emotion profile. The driver is free to ignore any field
 * whose asset is missing on the current model — callers MUST treat "missing
 * asset" as a no-op, never as an error.
 */
export interface Live2DEmotionBinding {
  /** Motion group name (e.g. "IDLE", "idle", "tap_body"). */
  motion?: string
  /** Optional index inside the motion group. */
  motionIndex?: number
  /** Cubism expression name (e.g. "爱心眼", "frown", "smile"). */
  expression?: string
  /** Higher priority overrides a previously playing lower-priority bind. */
  priority?: number
}

/** Mapping from an Emotion to its Live2D-side representation. */
export type Live2DEmotionProfile = Partial<Record<Emotion, Live2DEmotionBinding>>

/**
 * Default profile — intentionally model-agnostic. Each emotion falls back to
 * the same motion group ("idle") and uses the emotion name itself as the
 * expression name. Real models can override this profile in user data
 * (see §13.1) without changing the protocol.
 */
export const DEFAULT_LIVE2D_EMOTION_PROFILE: Live2DEmotionProfile = {
  neutral: { motion: "idle" },
  happy: { motion: "idle", expression: "happy" },
  sad: { motion: "idle", expression: "sad" },
  angry: { motion: "idle", expression: "angry" },
  surprised: { motion: "idle", expression: "surprised" },
  thinking: { motion: "idle", expression: "thinking" },
  embarrassed: { motion: "idle", expression: "embarrassed" },
  scared: { motion: "idle", expression: "scared" },
  confused: { motion: "idle", expression: "confused" },
  tired: { motion: "idle", expression: "tired" },
  love: { motion: "idle", expression: "love" },
  speechless: { motion: "idle", expression: "speechless" },
}

/* ------------------------------------------------------------------ */
/*  Resolution helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve the binding for a given emotion using the supplied profile.
 *
 * Resolution rules (per docs §13.2):
 *  1. The emotion's own entry is preferred.
 *  2. Missing entry ⇒ fall back to the `neutral` binding.
 *  3. `neutral` is also missing ⇒ return `undefined` (caller should treat
 *     as "do nothing" — no motion, no expression change).
 */
export function resolveEmotionBinding(
  profile: Live2DEmotionProfile,
  emotion: Emotion,
): Live2DEmotionBinding | undefined {
  const direct = profile[emotion]
  if (direct) return direct
  if (emotion === "neutral") return undefined
  return profile.neutral
}
