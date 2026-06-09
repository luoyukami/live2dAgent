import { EMOTION_VALUES, type Emotion, type EmotionSettings, type PromptPresetSettings } from "@live2d-agent/shared"
import { getTtsInstructionPrompt, TTS_INSTRUCTION_MARKER } from "./tts-instruction-prompt.js"

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

const EMPTY_USER_INFO = "用户暂未填写固定信息。不要臆测用户资料；需要时向用户确认。"

/**
 * Compose the user-editable prompt presets into a stable markdown system prompt.
 * The headings are intentionally hard-coded so user text is slotted into a
 * predictable structure before the emotion block is appended.
 */
export function composePromptPresetInstructions(presets: PromptPresetSettings): string {
  const rolePrompt = normalizePromptPart(presets.rolePrompt)
  const userInfoPrompt = normalizePromptPart(presets.userInfoPrompt)

  return `# Assistant Runtime Prompt

## 角色提示词

${rolePrompt}

## 用户信息提示词

${userInfoPrompt || EMPTY_USER_INFO}

## 固定行为与工具规则

- 上面的“角色提示词”定义你的身份、语气、风格和长期职责；在不违背安全、事实和用户指令的前提下保持一致。
- 上面的“用户信息提示词”只作为用户长期偏好和背景参考；不要泄露、复述或过度推断其中未明确要求使用的信息。
- 普通对话直接用自然语言回答；技术/严肃任务优先清晰、准确、简洁。
- 不编造能力、文件、工具结果或事实；不确定时说明不确定，并给出可验证的方法。
- 不要为问候、闲聊或仅凭对话即可回答的问题调用工具。
- 仅在完成用户明确请求确实需要时使用工具。
- 只有用户明确要求读写剪贴板时，才使用 clipboard 工具。
- 只有用户明确委托一个需要标记完成的任务时，才使用 task.finish；不要在闲聊中使用它。
- 执行有风险操作前先确认；文件和 shell 操作必须保持在配置的 workspace 内。`
}

function normalizePromptPart(value: string | undefined): string {
  return (value ?? "").trim()
}

/**
 * Marker that we append at the end of the system prompt so the AgentSession /
 * debug panel can detect that the emotion block has been injected exactly once.
 */
export const EMOTION_PROMPT_MARKER = "## Assistant Emotion Tag"

/**
 * Compose the final system prompt from a base prompt plus the emotion tag
 * section, gated by the user's EmotionSettings, and optionally the TTS
 * instruction prompt for LLM-controlled emotion mode.
 *
 * - When the system is disabled, the base prompt is returned unchanged.
 * - When the system is enabled but already contains the marker, we do not
 *   inject a duplicate.
 * - The emotion injection happens at the *end* of the prompt, separated by
 *   a blank line, so it doesn't disturb user-defined system content.
 * - When TTS is enabled with `emotionControlMode: "llm_controlled"`, the
 *   TTS instruction prompt is appended after the emotion instructions.
 */
export function composeSystemPrompt(
  basePrompt: string | undefined,
  settings: Pick<EmotionSettings, "enabled" | "injectPrompt">,
  ttsSettings?: { enabled: boolean; ttsMode?: "standard" | "emotion_enhanced"; emotionControlMode?: "default_mapping" | "llm_controlled" },
): string {
  const base = (basePrompt ?? "").trim()

  // Build the prompt without TTS injection first
  let result: string
  if (!settings.enabled || !settings.injectPrompt) {
    result = base
  } else if (base.includes(EMOTION_PROMPT_MARKER)) {
    result = base
  } else {
    result = base.length === 0 ? getEmotionTagInstructions() : `${base}\n\n${getEmotionTagInstructions()}`
  }

  // Inject TTS instruction prompt only when:
  // - TTS is enabled
  // - TTS mode is emotion_enhanced
  // - emotion control mode is llm_controlled
  if (
    ttsSettings?.enabled &&
    ttsSettings.ttsMode === "emotion_enhanced" &&
    ttsSettings.emotionControlMode === "llm_controlled"
  ) {
    if (!result.includes(TTS_INSTRUCTION_MARKER)) {
      const ttsPrompt = getTtsInstructionPrompt()
      result = result.length === 0 ? ttsPrompt : `${result}\n\n${ttsPrompt}`
    }
  }

  return result
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
