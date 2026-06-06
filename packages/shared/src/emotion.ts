/**
 * Canonical list of emotion values understood by the local rendering layer.
 *
 * Add new values here ONLY when:
 *  - The LLM prompt needs to request the new label.
 *  - The renderer / Live2D layer can map it to a meaningful representation.
 *
 * The LLM is asked to emit exactly one trailing <emotion value="..." /> tag
 * whose value must be in this list.
 */
export const EMOTION_VALUES = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "thinking",
  "embarrassed",
  "scared",
  "confused",
  "tired",
  "love",
  "speechless",
] as const

export type Emotion = (typeof EMOTION_VALUES)[number]

/** Type guard for Emotion values. */
export function isEmotion(value: unknown): value is Emotion {
  return (
    typeof value === "string" &&
    (EMOTION_VALUES as readonly string[]).includes(value)
  )
}

/* ------------------------------------------------------------------ */
/*  Emotion settings                                                   */
/* ------------------------------------------------------------------ */

/** How the local app handles the trailing <emotion /> tag emitted by the LLM. */
export interface EmotionSettings {
  /** Master switch — when false, the agent does not inject any emotion prompt
   *  and the Live2D layer must not react to fallback emotions. */
  enabled: boolean
  /** Whether to inject the "Assistant Emotion Tag" instructions into the
   *  system prompt. Forced to false when `enabled` is false. */
  injectPrompt: boolean
  /** Emotion used when parsing fails or when the system is disabled. */
  defaultEmotion: Emotion
  /** When the system is disabled but the model still emits a trailing tag,
   *  strip it from the visible text. */
  stripTagWhenDisabled: boolean
}

export const DEFAULT_EMOTION_SETTINGS: EmotionSettings = {
  enabled: true,
  injectPrompt: true,
  defaultEmotion: "neutral",
  stripTagWhenDisabled: true,
}

/* ------------------------------------------------------------------ */
/*  Emotion → renderer binding                                         */
/* ------------------------------------------------------------------ */

/**
 * One row of the per-emotion profile. The renderer is free to ignore any
 * field whose asset is missing on the current model — callers MUST treat
 * "missing asset" as a no-op, never as an error.
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

/** Mapping from an Emotion to its renderer-side representation. */
export type Live2DEmotionProfile = Partial<Record<Emotion, Live2DEmotionBinding>>

/**
 * Default profile — intentionally model-agnostic. Each emotion falls back to
 * the same motion group ("idle") and uses the emotion name itself as the
 * expression name. Real models can override this profile in user data
 * (see docs §13.1) without changing the protocol.
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
/*  Profile resolution                                                 */
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
  profile: Live2DEmotionProfile | undefined | null,
  emotion: Emotion,
): Live2DEmotionBinding | undefined {
  if (!profile) return undefined
  const direct = profile[emotion]
  if (direct) return direct
  if (emotion === "neutral") return undefined
  return profile.neutral
}
