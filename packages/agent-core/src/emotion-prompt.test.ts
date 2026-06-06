import { test } from "node:test"
import assert from "node:assert/strict"
import {
  composeSystemPrompt,
  getEmotionTagInstructions,
  isEmotionPromptInjected,
  EMOTION_PROMPT_MARKER,
} from "./emotion-prompt.js"
import { DEFAULT_EMOTION_SETTINGS } from "@live2d-agent/shared"

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
