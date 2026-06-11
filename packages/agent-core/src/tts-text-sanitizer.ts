/**
 * Text sanitization utilities for TTS consumption.
 *
 * Removes LLM control tags, metadata, and markdown formatting from
 * assistant message text to produce clean text suitable for speech synthesis.
 */

/**
 * Regex to match `<emotion value="..." />` tags anywhere in the text.
 * Captures the emotion value but we remove the entire tag.
 */
const EMOTION_TAG_RE = /<emotion\s+value\s*=\s*["'][a-z_]+["']\s*\/>/gi

/**
 * Regex to match emoji characters.
 * Covers common emoji Unicode ranges: emoticons, symbols, transport, etc.
 */
const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}]/gu

/**
 * Regex to match individual characters commonly found in kaomoji (颜文字).
 *
 * Kaomoji use characters from these Unicode ranges that are almost never
 * meaningful in Chinese/English TTS text:
 * - Latin-1 Supplement diacritics: U+00A0–U+00BF (macron ¯, degree °, etc.)
 * - Combining Diacritical Marks: U+0300–U+036F
 * - Greek and Coptic: U+0370–U+03FF (Σ, Ω, etc. used in kaomoji expressions)
 * - General Punctuation (select): U+203F (undertie ‿)
 * - Arrows: U+2190–U+21FF (←→↑↓ etc.)
 * - Misc Technical: U+2300–U+23FF (⌂⚽ etc.)
 * - Box Drawing: U+2500–U+257F (═║╗ etc.)
 * - Block Elements: U+2580–U+259F (▀▄ etc.)
 * - Geometric Shapes: U+25A0–U+25FF (□■△▽ etc.)
 * - Misc Symbols: U+2600–U+26FF (☀☁ etc.)
 * - Dingbats: U+2700–U+27BF (✦✧ etc.)
 * - Katakana: U+30A0–U+30FF (ツヅ etc. — common in Japanese-style kaomoji)
 * - CJK Compatibility Forms: U+FE30–U+FE4F (﹏﹋ etc.)
 *
 * Individual characters from these ranges are removed one-by-one.
 */
const KAOMOJI_CHARS_RE =
  /[\u00A0-\u00BF\u0300-\u036F\u0370-\u03FF\u203F\u2190-\u21FF\u2300-\u23FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u30A0-\u30FF\uFE30-\uFE4F]/g

/**
 * Regex to match structural sequences left over after removing kaomoji characters.
 * These are runs of 2+ non-CJK, non-alphanumeric characters like \_/ or |||.
 */
const KAOMOJI_STRUCTURAL_RE = /[\_\\\/\~\|＜＞〈〉《》【】\[\]]{2,}/g

/**
 * Regex to match `[[TTS_INSTRUCTION:...]]` tags anywhere in the text.
 * NOTE: Not using the `g` flag to avoid lastIndex state issues on repeated calls.
 */
const TTS_INSTRUCTION_TAG_RE = /\[\[TTS_INSTRUCTION:([\s\S]*?)\]\]/

/**
 * Regex to match ALL `[[TTS_INSTRUCTION:...]]` tags for removal.
 */
const TTS_INSTRUCTION_TAG_RE_GLOBAL = /\[\[TTS_INSTRUCTION:[\s\S]*?\]\]/g

/**
 * Regex to match markdown links: [title](url) → "title"
 */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g

/**
 * Regex to match fenced code blocks (``` ... ```).
 * We need to handle both opening and closing fences.
 */
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g

/**
 * Placeholder text used when a code block is too long for TTS.
 */
const CODE_BLOCK_PLACEHOLDER = "我给你写了一段代码，具体内容请看屏幕。"

/**
 * Maximum code block length (in characters) before replacing with placeholder.
 */
const CODE_BLOCK_LENGTH_THRESHOLD = 200

/**
 * Remove emoji and kaomoji (颜文字) from text.
 *
 * Processing steps:
 * 1. Remove standard emoji via EMOJI_RE
 * 2. Remove individual kaomoji characters from special Unicode ranges
 * 3. Remove structural sequences (e.g. \_/  |||) left over
 * 4. Remove empty parentheses
 * 5. Collapse multiple spaces
 *
 * @param text Input text
 * @returns Text with emoji and kaomoji removed
 */
export function removeEmojiAndKaomoji(text: string): string {
  if (!text) return ""
  let result = text
  // 1. Remove standard emoji
  result = result.replace(EMOJI_RE, "")
  // 2. Remove individual kaomoji characters
  result = result.replace(KAOMOJI_CHARS_RE, "")
  // 3. Remove structural sequences left over
  result = result.replace(KAOMOJI_STRUCTURAL_RE, "")
  // 4. Remove empty or whitespace-only parentheses
  result = result.replace(/[\(（]\s*[\)）]/g, "")
  // 5. Collapse multiple spaces (but preserve newlines for blank-line trimming)
  result = result.replace(/[ \t]{2,}/g, " ").trim()
  return result
}

/**
 * Smart segmentation for long Chinese text.
 *
 * Splits text at natural boundaries (punctuation, particles) into segments
 * of approximately 20-40 characters. Segments exceeding 30 characters
 * will be split.
 *
 * Natural split points include:
 * - Chinese punctuation: 。！？；，、：
 * - Sentence-ending particles: 啊呢吧呀哦嘛
 * - Conjunctions: 但是然而不过而且并且
 * - Spaces (for mixed content)
 *
 * @param text Input text
 * @param maxSegmentLength Maximum segment length (default: 40)
 * @param triggerLength Length at which to start splitting (default: 30)
 * @returns Array of text segments
 */
export function segmentLongText(
  text: string,
  maxSegmentLength: number = 40,
  triggerLength: number = 30,
): string[] {
  if (!text || text.length <= triggerLength) {
    return text ? [text] : []
  }

  const segments: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= triggerLength) {
      segments.push(remaining)
      break
    }

    // Look for the best split point within maxSegmentLength
    let splitIndex = -1

    // Priority 1: Find punctuation within the range
    const punctuationPattern = /[。！？；，、：]/
    for (let i = Math.min(maxSegmentLength, remaining.length) - 1; i >= Math.floor(maxSegmentLength * 0.5); i--) {
      if (punctuationPattern.test(remaining[i])) {
        splitIndex = i + 1
        break
      }
    }

    // Priority 2: Find particles or conjunctions
    if (splitIndex === -1) {
      const particlePattern = /[呢吧呀哦嘛]/
      const conjunctionPattern = /但是|然而|不过|而且|并且/
      for (let i = Math.min(maxSegmentLength, remaining.length) - 1; i >= Math.floor(maxSegmentLength * 0.5); i--) {
        const char = remaining[i]
        if (particlePattern.test(char)) {
          splitIndex = i + 1
          break
        }
        // Check for 2-char conjunctions
        if (i >= 1) {
          const bigram = remaining.slice(i - 1, i + 1)
          if (conjunctionPattern.test(bigram)) {
            splitIndex = i - 1
            break
          }
        }
      }
    }

    // Priority 3: Find spaces
    if (splitIndex === -1) {
      for (let i = Math.min(maxSegmentLength, remaining.length) - 1; i >= Math.floor(maxSegmentLength * 0.5); i--) {
        if (remaining[i] === " ") {
          splitIndex = i + 1
          break
        }
      }
    }

    // Fallback: Split at maxSegmentLength
    if (splitIndex === -1) {
      splitIndex = maxSegmentLength
    }

    segments.push(remaining.slice(0, splitIndex).trim())
    remaining = remaining.slice(splitIndex).trim()
  }

  return segments.filter((s) => s.length > 0)
}

/**
 * Remove all control tags and metadata from assistant message text,
 * leaving only user-visible content suitable for TTS.
 *
 * Processing steps:
 * 1. Remove emotion tags: `<emotion value="..." />`
 * 2. Remove TTS instruction tags: `[[TTS_INSTRUCTION:...]]`
 * 3. Convert markdown links `[title](url)` → `"title"`
 * 4. Replace long code blocks with placeholder text
 * 5. Remove emoji and kaomoji
 * 6. Trim extra blank lines
 */
export function sanitizeTextForTts(rawAssistantMessage: string): string {
  if (!rawAssistantMessage) return ""

  let text = rawAssistantMessage

  // 1. Remove emotion tags
  text = text.replace(EMOTION_TAG_RE, "")

  // 2. Remove TTS instruction tags
  text = text.replace(TTS_INSTRUCTION_TAG_RE, "")

  // 3. Convert markdown links to just the title
  text = text.replace(MARKDOWN_LINK_RE, "$1")

  // 4. Replace fenced code blocks with placeholder or remove
  text = text.replace(FENCED_CODE_BLOCK_RE, (match) => {
    return match.length > CODE_BLOCK_LENGTH_THRESHOLD ? CODE_BLOCK_PLACEHOLDER : ""
  })

  // 5. Remove emoji and kaomoji
  text = removeEmojiAndKaomoji(text)

  // 6. Trim extra blank lines (collapse 2+ blank lines into one)
  text = text.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n")

  // 7. Trim leading/trailing whitespace
  text = text.trim()

  return text
}

/**
 * Extract TTS instruction from raw assistant message.
 *
 * Finds the first `[[TTS_INSTRUCTION:...]]` tag, extracts the instruction text,
 * removes ALL such tags from the text, and returns both.
 *
 * @returns An object with `instruction` and `cleanedText`, or `null` if no tag found.
 */
export function extractTtsInstruction(
  rawText: string,
): { instruction: string; cleanedText: string } | null {
  if (!rawText) return null

  // Find the first match (non-global regex to avoid lastIndex state issues)
  const firstMatch = TTS_INSTRUCTION_TAG_RE.exec(rawText)
  if (!firstMatch) return null

  const instruction = firstMatch[1]?.trim() ?? ""

  // Limit instruction to 100 characters
  const truncatedInstruction =
    instruction.length > 100 ? instruction.slice(0, 100) : instruction

  // Remove ALL TTS instruction tags from the text (global regex for replacement)
  const cleanedText = rawText.replace(TTS_INSTRUCTION_TAG_RE_GLOBAL, "").trim()

  return {
    instruction: truncatedInstruction,
    cleanedText,
  }
}
