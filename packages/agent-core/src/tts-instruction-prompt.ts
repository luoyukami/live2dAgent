/**
 * TTS instruction prompt injection for LLM-controlled emotion mode.
 *
 * When TTS is enabled with `emotionControlMode: "llm_controlled"`, this prompt
 * is injected into the system prompt so the LLM generates a natural language
 * TTS instruction alongside its regular response.
 */

/**
 * The full TTS instruction prompt text.
 */
export const TTS_INSTRUCTION_PROMPT = `你还需要为本次回复额外生成一条 TTS 语音控制指令，用于描述这句话应该如何被朗读。

严格要求：
1. 在回复正文后单独追加一行，格式必须是：
[[TTS_INSTRUCTION:这里填写一句中文自然语言朗读指令]]
2. 如果系统同时要求输出 <emotion ... /> 情绪标签，最终顺序必须是：回复正文、TTS_INSTRUCTION、最后一行的 emotion tag。此时 TTS_INSTRUCTION 不是最后一行。
3. 如果没有要求输出 emotion tag，则 TTS_INSTRUCTION 是最后一行。
4. TTS_INSTRUCTION 只能描述语气、情绪、语速、音量倾向、说话风格。
5. 不要复述正文内容，不要加入新的事实信息。
6. 指令长度控制在 6~18 个中文字符，越短越好。
7. 不要使用 Markdown 代码块包裹。
8. 不要输出多个 TTS_INSTRUCTION。
9. 即使正文很短，也必须输出该标签。
10. 用“强度 + 情感/状态 + 语速”的短句，不要写完整长句。
11. 不要加入“请”“这句话”“保持音色”等冗余词。
12. 情绪强度要克制，优先使用“轻度”，强烈语境才使用“中度”。

示例：
[[TTS_INSTRUCTION:平静自然，语速平缓。]]
[[TTS_INSTRUCTION:轻度的活泼开心，语速稍快。]]
[[TTS_INSTRUCTION:轻度的低落难过，语速稍慢。]]`

/**
 * Marker prefix used to detect whether TTS instruction has already been injected.
 */
export const TTS_INSTRUCTION_MARKER = "[[TTS_INSTRUCTION:"

/**
 * Return the canonical TTS instruction prompt text.
 */
export function getTtsInstructionPrompt(): string {
  return TTS_INSTRUCTION_PROMPT
}

/**
 * Check whether a system prompt already contains the TTS instruction marker.
 * Used to avoid duplicate injection.
 */
export function isTtsInstructionInjected(systemPrompt: string | undefined): boolean {
  if (!systemPrompt) return false
  return systemPrompt.includes(TTS_INSTRUCTION_MARKER)
}
