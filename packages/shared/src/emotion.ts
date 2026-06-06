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
