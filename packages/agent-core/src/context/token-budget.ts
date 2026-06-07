/**
 * Lightweight token estimation for the ContextManager.
 *
 * Uses a simple character-count heuristic rather than a full tokenizer.
 * This is sufficient for budget enforcement; exact token counts are
 * the model provider's responsibility.
 *
 * Heuristic:
 *   - ASCII / Latin-1: ~4 chars per token
 *   - CJK / wide chars: ~1.5 chars per token
 *   - We use a blended estimate of 3.5 chars per token as a conservative
 *     approximation that works reasonably well for mixed content.
 *
 * See docs/ws_model_communication_architecture.md §16.
 */

/** Average chars per token for estimation. */
const CHARS_PER_TOKEN = 3.5

/**
 * Estimate the number of tokens in a string.
 * Uses simple character-count / 3.5 heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimate tokens for an array of message objects.
 * Includes a small overhead per message for role/metadata framing.
 */
export function estimateMessageTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0
  for (const msg of messages) {
    // ~4 tokens overhead per message for role label and formatting
    total += estimateTokens(msg.content) + 4
  }
  return total
}
