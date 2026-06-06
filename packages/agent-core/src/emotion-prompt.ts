import { EMOTION_VALUES, type Emotion, type EmotionSettings } from "@live2d-agent/shared"

/**
 * The trailing-tag protocol is described in the emotion requirements doc.
 *
 * The model is asked to put the tag on the *last* line of its reply so we can
 * reliably strip it without affecting the visible text. We deliberately do NOT
 * instruct the model to write the tag first — that would interfere with the
 * model's ability to organise its reply.
 */
const EMOTION_TAG_INSTRUCTIONS = `## Assistant Emotion Tag

When emotion tags are enabled, every assistant text reply MUST end with exactly one emotion tag on its final line.

Use this exact format:

<emotion value="{emotion}" />

Allowed emotion values:
${EMOTION_VALUES.join(", ")}.

Choose the emotion that best matches your reply. Use neutral when there is no clear emotion.

The emotion tag is for local rendering only. Do not explain it. Do not mention it. Do not put it in a code block or quote block. Do not output more than one emotion tag.`

/**
 * Return the canonical emotion-tag instruction block. The text is constant;
 * the function exists so it can be tested and overridden in one place.
 */
export function getEmotionTagInstructions(): string {
  return EMOTION_TAG_INSTRUCTIONS
}

/**
 * Marker that we append at the end of the system prompt so the AgentSession /
 * debug panel can detect that the emotion block has been injected exactly once.
 */
export const EMOTION_PROMPT_MARKER = "## Assistant Emotion Tag"

/**
 * Compose the final system prompt from a base prompt plus the emotion tag
 * section, gated by the user's EmotionSettings.
 *
 * - When the system is disabled, the base prompt is returned unchanged.
 * - When the system is enabled but already contains the marker, we do not
 *   inject a duplicate.
 * - The injection happens at the *end* of the prompt, separated by a blank
 *   line, so it doesn't disturb user-defined system content.
 */
export function composeSystemPrompt(
  basePrompt: string | undefined,
  settings: Pick<EmotionSettings, "enabled" | "injectPrompt">,
): string {
  const base = (basePrompt ?? "").trim()
  if (!settings.enabled || !settings.injectPrompt) return base
  if (base.includes(EMOTION_PROMPT_MARKER)) return base
  return base.length === 0 ? getEmotionTagInstructions() : `${base}\n\n${getEmotionTagInstructions()}`
}

/**
 * Did this composed system prompt end up containing the emotion section?
 * Useful for the debug panel "Prompt injected" indicator.
 */
export function isEmotionPromptInjected(systemPrompt: string | undefined): boolean {
  if (!systemPrompt) return false
  return systemPrompt.includes(EMOTION_PROMPT_MARKER)
}

/** Sanity helper — exposes the canonical emotion list to the rest of core. */
export function listEmotionValues(): readonly Emotion[] {
  return EMOTION_VALUES
}
