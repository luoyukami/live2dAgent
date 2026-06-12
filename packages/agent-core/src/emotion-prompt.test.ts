import { test } from "node:test"
import assert from "node:assert/strict"
import {
  composeSystemPrompt,
  composePromptPresetInstructions,
  getEmotionTagInstructions,
  isEmotionPromptInjected,
  EMOTION_PROMPT_MARKER,
} from "./emotion-prompt.js"
import { DEFAULT_EMOTION_SETTINGS } from "@live2d-agent/shared"
import { TTS_INSTRUCTION_MARKER, getTtsInstructionPrompt } from "./tts-instruction-prompt.js"

test("injectPrompt=true + enabled=true appends the emotion block", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(base, { enabled: true, injectPrompt: true })
  assert.ok(result.includes(base))
  assert.ok(result.includes(EMOTION_PROMPT_MARKER))
  assert.ok(result.includes("<emotion value=\"{emotion}\" />"))
})

test("enabled=false leaves the prompt untouched", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(base, { enabled: false, injectPrompt: true })
  assert.equal(result, base)
  assert.equal(isEmotionPromptInjected(result), false)
})

test("injectPrompt=false leaves the prompt untouched", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(base, { enabled: true, injectPrompt: false })
  assert.equal(result, base)
  assert.equal(isEmotionPromptInjected(result), false)
})

test("marker already present => no duplicate injection", () => {
  const base = `Header line\n\n${getEmotionTagInstructions()}\n`
  const result = composeSystemPrompt(base, { enabled: true, injectPrompt: true })
  // Count occurrences of the marker.
  const matches = result.match(/## Assistant Emotion Tag/g) ?? []
  assert.equal(matches.length, 1)
})

test("prompt ends with the emotion instructions (not user content)", () => {
  const result = composeSystemPrompt("base prompt", { enabled: true, injectPrompt: true })
  assert.ok(
    result.endsWith(getEmotionTagInstructions().trimEnd()),
    "emotion block must be the last segment",
  )
})

test("undefined base prompt + enabled = a usable prompt", () => {
  const result = composeSystemPrompt(undefined, { enabled: true, injectPrompt: true })
  assert.ok(result.includes(EMOTION_PROMPT_MARKER))
  assert.equal(isEmotionPromptInjected(result), true)
})

test("default emotion settings inject by default", () => {
  const result = composeSystemPrompt("base", DEFAULT_EMOTION_SETTINGS)
  assert.equal(isEmotionPromptInjected(result), true)
})

test("isEmotionPromptInjected recognises the marker", () => {
  assert.equal(isEmotionPromptInjected("Hello\n\n## Assistant Emotion Tag\n"), true)
  assert.equal(isEmotionPromptInjected("just a plain prompt"), false)
  assert.equal(isEmotionPromptInjected(undefined), false)
})

test("composePromptPresetInstructions slots role, behavior rules, and user reference into markdown sections", () => {
  const result = composePromptPresetInstructions({
    rolePrompt: "你是小花。",
    userInfoPrompt: "用户偏好中文。",
  })

  assert.ok(result.includes("# Assistant Runtime Prompt"))
  assert.ok(result.includes("## 角色提示词\n\n你是小花。"))
  assert.ok(result.includes("## 固定行为与工具规则"))
  assert.ok(result.includes("## 参考信息｜用户\n\n用户偏好中文。"))
  assert.ok(result.indexOf("## 固定行为与工具规则") < result.indexOf("## 参考信息｜用户"))
})

test("emotion instructions define TTS-before-emotion output order", () => {
  const instructions = getEmotionTagInstructions()
  assert.ok(instructions.includes("reply body, then one TTS_INSTRUCTION line, then the emotion tag as the final line"))
  assert.ok(instructions.includes("The emotion tag always remains the last line"))
})

/* ------------------------------------------------------------------ */
/*  TTS instruction injection tests                                    */
/* ------------------------------------------------------------------ */

test("ttsSettings with llm_controlled mode injects TTS instruction prompt", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(
    base,
    { enabled: false, injectPrompt: false },
    { enabled: true, ttsMode: "emotion_enhanced", emotionControlMode: "llm_controlled" },
  )
  assert.ok(result.includes(base))
  assert.ok(result.includes(TTS_INSTRUCTION_MARKER))
  assert.ok(result.includes(getTtsInstructionPrompt()))
})

test("ttsSettings with default_mapping mode does NOT inject TTS instruction", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(
    base,
    { enabled: false, injectPrompt: false },
    { enabled: true, ttsMode: "emotion_enhanced", emotionControlMode: "default_mapping" },
  )
  assert.ok(result.includes(base))
  assert.ok(!result.includes(TTS_INSTRUCTION_MARKER))
})

test("ttsSettings disabled does NOT inject TTS instruction", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(
    base,
    { enabled: false, injectPrompt: false },
    { enabled: false, ttsMode: "emotion_enhanced", emotionControlMode: "llm_controlled" },
  )
  assert.ok(result.includes(base))
  assert.ok(!result.includes(TTS_INSTRUCTION_MARKER))
})

test("TTS instruction comes AFTER emotion instructions when both enabled", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(
    base,
    { enabled: true, injectPrompt: true },
    { enabled: true, ttsMode: "emotion_enhanced", emotionControlMode: "llm_controlled" },
  )
  const emotionPos = result.indexOf(EMOTION_PROMPT_MARKER)
  const ttsPos = result.indexOf(TTS_INSTRUCTION_MARKER)
  assert.ok(emotionPos >= 0, "emotion marker should be present")
  assert.ok(ttsPos >= 0, "TTS marker should be present")
  assert.ok(emotionPos < ttsPos, "emotion instructions should come before TTS instructions")
})

test("no duplicate TTS injection when marker already present", () => {
  const base = `Prompt with ${TTS_INSTRUCTION_MARKER}already injected]]`
  const result = composeSystemPrompt(
    base,
    { enabled: false, injectPrompt: false },
    { enabled: true, ttsMode: "emotion_enhanced", emotionControlMode: "llm_controlled" },
  )
  const matches = result.match(/\[\[TTS_INSTRUCTION:/g) ?? []
  assert.equal(matches.length, 1)
})

test("undefined ttsSettings does not affect output", () => {
  const base = "You are a helpful assistant."
  const result = composeSystemPrompt(
    base,
    { enabled: true, injectPrompt: true },
    undefined,
  )
  assert.ok(result.includes(EMOTION_PROMPT_MARKER))
  assert.ok(!result.includes(TTS_INSTRUCTION_MARKER))
})
