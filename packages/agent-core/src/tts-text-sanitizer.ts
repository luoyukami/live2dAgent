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
 * Remove all control tags and metadata from assistant message text,
 * leaving only user-visible content suitable for TTS.
 *
 * Processing steps:
 * 1. Remove emotion tags: `<emotion value="..." />`
 * 2. Remove TTS instruction tags: `[[TTS_INSTRUCTION:...]]`
 * 3. Convert markdown links `[title](url)` → `"title"`
 * 4. Replace long code blocks with placeholder text
 * 5. Trim extra blank lines
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

  // 5. Trim extra blank lines (collapse 2+ blank lines into one)
  text = text.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n")

  // 6. Trim leading/trailing whitespace
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
