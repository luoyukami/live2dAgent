import { isEmotion, type Emotion, type EmotionSettings } from "@live2d-agent/shared"

/* ------------------------------------------------------------------ */
/*  Parser contract (see docs/情绪功能开发需求.md §9)                  */
/* ------------------------------------------------------------------ */

export interface ParseEmotionTagOptions {
  enabled: boolean
  defaultEmotion: Emotion
  stripTagWhenDisabled: boolean
}

export type EmotionSource = "llm-tag" | "fallback" | "disabled"

export interface ParsedEmotionMessage {
  /** Text safe to show in the chat UI (tag removed). */
  visibleText: string
  /** The emotion that should drive the renderer (Live2D etc). */
  emotion: Emotion
  /** Where the emotion came from. */
  emotionSource: EmotionSource
  /** Original raw text, kept for debug / trace purposes. */
  rawText: string
  /** The raw `<emotion ... />` tag if one was found at the end (and stripped). */
  rawEmotionTag?: string
  /** Set when the model failed to emit a valid tag (or emitted an invalid one). */
  parseWarning?: string
}

/**
 * Match a trailing `<emotion value="..." />` tag, optionally preceded/followed
 * by whitespace and a single newline. The captured value is *not* validated
 * against the enum here — that's the caller's job (via isEmotion).
 *
 * Notes:
 * - We deliberately do NOT anchor to the start of the string: the tag may be
 *   inline (e.g. "你好<emotion value=\"happy\" />") or on its own line.
 * - We DO anchor to the end (`$`) so that tags in the middle of a code block
 *   or in the body are NOT accidentally consumed.
 */
const EMOTION_TAIL_TAG_RE =
  /(?:\r?\n)?[ \t]*<emotion\s+value\s*=\s*["']([a-z_]+)["']\s*\/>[ \t]*(?:\r?\n)?[ \t]*$/i

const PARSE_WARNING_MISSING = "Missing or invalid emotion tag"
const PARSE_WARNING_INVALID = "Emotion tag value is not in EMOTION_VALUES"

/**
 * Parse a trailing emotion tag out of an assistant message.
 *
 * Never throws. Any unexpected input degrades to a safe fallback.
 */
export function parseEmotionTag(
  rawText: string,
  options: ParseEmotionTagOptions,
): ParsedEmotionMessage {
  const raw = rawText ?? ""
  const fallbackEmotion = options.defaultEmotion

  // Disabled — leave text alone (or strip) and tag the source as disabled.
  if (!options.enabled) {
    if (!options.stripTagWhenDisabled) {
      return {
        visibleText: raw,
        emotion: fallbackEmotion,
        emotionSource: "disabled",
        rawText: raw,
      }
    }

    const stripped = stripEmotionTag(raw)
    if (stripped === null) {
      return {
        visibleText: raw,
        emotion: fallbackEmotion,
        emotionSource: "disabled",
        rawText: raw,
      }
    }

    return {
      visibleText: stripped.visibleText,
      emotion: fallbackEmotion,
      emotionSource: "disabled",
      rawText: raw,
      rawEmotionTag: stripped.rawEmotionTag,
    }
  }

  // Enabled — try to parse a trailing tag.
  const stripped = stripEmotionTag(raw)
  if (stripped === null) {
    return {
      visibleText: raw,
      emotion: fallbackEmotion,
      emotionSource: "fallback",
      rawText: raw,
      parseWarning: PARSE_WARNING_MISSING,
    }
  }

  const { candidate, visibleText, rawEmotionTag } = stripped
  if (!isEmotion(candidate)) {
    // Tag was well-formed but the value is not in our enum.
    return {
      visibleText: raw,
      emotion: fallbackEmotion,
      emotionSource: "fallback",
      rawText: raw,
      rawEmotionTag,
      parseWarning: PARSE_WARNING_INVALID,
    }
  }

  return {
    visibleText,
    emotion: candidate,
    emotionSource: "llm-tag",
    rawText: raw,
    rawEmotionTag,
  }
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

interface StrippedEmotion {
  /** Validated emotion enum value. */
  candidate: string
  /** Visible text with the trailing tag removed (and trailing blank lines trimmed). */
  visibleText: string
  /** The raw tag text (including surrounding whitespace / newline). */
  rawEmotionTag: string
}

/**
 * Try to extract a trailing `<emotion value="..." />` tag.
 * Returns `null` when no well-formed trailing tag is present.
 */
function stripEmotionTag(raw: string): StrippedEmotion | null {
  if (!raw) return null
  const match = raw.match(EMOTION_TAIL_TAG_RE)
  if (!match || match.index === undefined) return null

  const candidate = match[1] ?? ""
  const rawEmotionTag = match[0]
  const before = raw.slice(0, match.index)
  const visibleText = trimTrailingBlankLines(before)

  return { candidate, visibleText, rawEmotionTag }
}

/** Remove trailing whitespace and blank lines, preserving a single final newline is NOT required. */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/(?:[ \t]*\r?\n)+[ \t]*$/u, "").replace(/[ \t]+$/u, "")
}

/* ------------------------------------------------------------------ */
/*  Helpers for callers                                                */
/* ------------------------------------------------------------------ */

/** Return the emotion section of an EmotionSettings object (or the full object). */
export function emotionSettingsForParsing(
  settings: EmotionSettings,
): ParseEmotionTagOptions {
  return {
    enabled: settings.enabled,
    defaultEmotion: settings.defaultEmotion,
    stripTagWhenDisabled: settings.stripTagWhenDisabled,
  }
}
