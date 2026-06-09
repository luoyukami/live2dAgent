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
  /** Extracted TTS instruction if LLM-controlled mode is enabled. */
  ttsInstruction?: string
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
 * Regex to match `[[TTS_INSTRUCTION:...]]` tags in the text.
 * Used to extract and remove TTS instructions from visible text.
 */
const TTS_INSTRUCTION_RE = /\[\[TTS_INSTRUCTION:([\s\S]*?)\]\]/g

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
      // Even when not stripping emotion tags, still extract TTS instructions
      const ttsResult = extractTtsInstructionFromText(raw)
      return {
        visibleText: ttsResult.visibleText,
        emotion: fallbackEmotion,
        emotionSource: "disabled",
        rawText: raw,
        ttsInstruction: ttsResult.ttsInstruction,
      }
    }

    const stripped = stripEmotionTag(raw)
    if (stripped === null) {
      const ttsResult = extractTtsInstructionFromText(raw)
      return {
        visibleText: ttsResult.visibleText,
        emotion: fallbackEmotion,
        emotionSource: "disabled",
        rawText: raw,
        ttsInstruction: ttsResult.ttsInstruction,
      }
    }

    const ttsResult = extractTtsInstructionFromText(stripped.visibleText)
    return {
      visibleText: ttsResult.visibleText,
      emotion: fallbackEmotion,
      emotionSource: "disabled",
      rawText: raw,
      rawEmotionTag: stripped.rawEmotionTag,
      ttsInstruction: ttsResult.ttsInstruction,
    }
  }

  // Enabled — try to parse a trailing tag.
  const stripped = stripEmotionTag(raw)
  if (stripped === null) {
    const ttsResult = extractTtsInstructionFromText(raw)
    return {
      visibleText: ttsResult.visibleText,
      emotion: fallbackEmotion,
      emotionSource: "fallback",
      rawText: raw,
      parseWarning: PARSE_WARNING_MISSING,
      ttsInstruction: ttsResult.ttsInstruction,
    }
  }

  const { candidate, visibleText, rawEmotionTag } = stripped
  if (!isEmotion(candidate)) {
    // Tag was well-formed but the value is not in our enum.
    // Keep the original raw text as visibleText (tag not stripped when invalid),
    // but still extract any TTS instruction.
    const ttsResult = extractTtsInstructionFromText(raw)
    return {
      visibleText: ttsResult.visibleText || raw,
      emotion: fallbackEmotion,
      emotionSource: "fallback",
      rawText: raw,
      rawEmotionTag,
      parseWarning: PARSE_WARNING_INVALID,
      ttsInstruction: ttsResult.ttsInstruction,
    }
  }

  const ttsResult = extractTtsInstructionFromText(visibleText)
  return {
    visibleText: ttsResult.visibleText,
    emotion: candidate,
    emotionSource: "llm-tag",
    rawText: raw,
    rawEmotionTag,
    ttsInstruction: ttsResult.ttsInstruction,
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

/**
 * Extract `[[TTS_INSTRUCTION:...]]` tags from text and return cleaned text
 * plus the extracted instruction (if any).
 *
 * The instruction is truncated to 100 characters.
 * ALL occurrences of the tag are removed from the visible text.
 */
function extractTtsInstructionFromText(text: string): {
  visibleText: string
  ttsInstruction: string | undefined
} {
  const firstMatch = TTS_INSTRUCTION_RE.exec(text)
  if (!firstMatch) {
    return { visibleText: text, ttsInstruction: undefined }
  }

  const rawInstruction = firstMatch[1]?.trim() ?? ""
  const ttsInstruction =
    rawInstruction.length > 100 ? rawInstruction.slice(0, 100) : rawInstruction

  // Reset regex lastIndex for the global replacement
  TTS_INSTRUCTION_RE.lastIndex = 0
  const visibleText = text.replace(TTS_INSTRUCTION_RE, "").trim()

  return { visibleText, ttsInstruction }
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
