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

/* ------------------------------------------------------------------ */
/*  TTS emotion instruction mapping                                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_TTS_EMOTION_INSTRUCTIONS: Record<string, string> = {
  neutral: "平静自然，语速平缓。",
  happy: "轻度的活泼开心，语速稍快。",
  sad: "轻度的低落难过，语速稍慢。",
  angry: "中度的不满生气，语速稍快。",
  surprised: "中度的惊讶轻快，语速稍快。",
  thinking: "轻度的思考平静，语速稍慢。",
  embarrassed: "轻度的害羞温柔，语速平缓。",
  scared: "中度的紧张害怕，语速稍快。",
  confused: "轻度的困惑迟疑，语速稍慢。",
  tired: "轻度的疲惫慵懒，语速稍慢。",
  love: "中度的温柔亲近，语速平缓。",
  speechless: "轻度的无奈平静，语速平缓。",
}

const MAX_TTS_EMOTION_INSTRUCTION_LENGTH = 18

function compactTtsEmotionInstruction(instruction: string): string {
  return instruction
    .replace(/^请(?:用|加入)?/, "")
    .replace(/(?:这句话|说一句话)/g, "")
    .replace(/\s+/g, "")
    .trim()
    .slice(0, MAX_TTS_EMOTION_INSTRUCTION_LENGTH)
    .replace(/[，、；：,.。;:]+$/, "")
}

export function composeTtsNaturalEmotionInstruction(
  emotionInstruction: string | undefined | null,
): string {
  const cleanedInstruction = emotionInstruction ? compactTtsEmotionInstruction(emotionInstruction) : ""
  return cleanedInstruction || DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral
}
