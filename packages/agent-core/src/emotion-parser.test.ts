import { test } from "node:test"
import assert from "node:assert/strict"
import { parseEmotionTag } from "./emotion-parser.js"

const ENABLED = { enabled: true, defaultEmotion: "neutral" as const, stripTagWhenDisabled: true }
const DISABLED_STRIP = { enabled: false, defaultEmotion: "neutral" as const, stripTagWhenDisabled: true }
const DISABLED_KEEP = { enabled: false, defaultEmotion: "neutral" as const, stripTagWhenDisabled: false }

test("standard multi-line trailing tag", () => {
  const result = parseEmotionTag('你好\n\n<emotion value="happy" />', ENABLED)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "happy")
  assert.equal(result.emotionSource, "llm-tag")
  assert.equal(result.parseWarning, undefined)
  assert.match(result.rawEmotionTag ?? "", /<emotion value="happy" \/>/)
})

test("inline trailing tag (no preceding newline)", () => {
  const result = parseEmotionTag('你好<emotion value="happy" />', ENABLED)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "happy")
  assert.equal(result.emotionSource, "llm-tag")
})

test("valid format with invalid emotion value -> fallback + warning", () => {
  const original = '你好\n<emotion value="invalid" />'
  const result = parseEmotionTag(original, ENABLED)
  assert.equal(result.visibleText, original)
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "fallback")
  assert.ok(result.parseWarning, "expected a parse warning")
})

test("tag in the front of the text -> not parsed, text untouched", () => {
  const original = '<emotion value="happy" />\n你好'
  const result = parseEmotionTag(original, ENABLED)
  assert.equal(result.visibleText, original)
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "fallback")
})

test("tag inside a fenced code block -> not parsed", () => {
  const original = '代码：\n```xml\n<emotion value="happy" />\n```'
  const result = parseEmotionTag(original, ENABLED)
  assert.equal(result.visibleText, original)
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "fallback")
})

test("empty input", () => {
  const result = parseEmotionTag("", ENABLED)
  assert.equal(result.visibleText, "")
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "fallback")
})

test("disabled + strip -> tag removed, source disabled, default emotion", () => {
  const result = parseEmotionTag('你好\n<emotion value="happy" />', DISABLED_STRIP)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "disabled")
  assert.match(result.rawEmotionTag ?? "", /<emotion value="happy" \/>/)
})

test("disabled + keep -> text untouched, source disabled, default emotion", () => {
  const original = '你好\n<emotion value="happy" />'
  const result = parseEmotionTag(original, DISABLED_KEEP)
  assert.equal(result.visibleText, original)
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "disabled")
})

test("CRLF line endings are tolerated", () => {
  const result = parseEmotionTag('你好\r\n\r\n<emotion value="sad" />', ENABLED)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "sad")
  assert.equal(result.emotionSource, "llm-tag")
})

test("single-quoted attribute value is tolerated", () => {
  const result = parseEmotionTag("你好\n<emotion value='thinking' />", ENABLED)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "thinking")
  assert.equal(result.emotionSource, "llm-tag")
})

test("self-closing tag without trailing space is tolerated", () => {
  const result = parseEmotionTag('你好\n<emotion value="happy"/>', ENABLED)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "happy")
  assert.equal(result.emotionSource, "llm-tag")
})

test("extra whitespace inside the tag is tolerated", () => {
  const result = parseEmotionTag('你好\n<emotion   value="love"   />', ENABLED)
  assert.equal(result.visibleText, "你好")
  assert.equal(result.emotion, "love")
  assert.equal(result.emotionSource, "llm-tag")
})

test("non-Latin script inside a fence must not parse as emotion", () => {
  const original = '中文：<emotion value="happy" /> 后面的文字'
  const result = parseEmotionTag(original, ENABLED)
  // The tag is mid-text, not trailing, so parser must ignore it.
  assert.equal(result.visibleText, original)
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "fallback")
})

test("disabled + strip, but no tag present", () => {
  const original = "你好"
  const result = parseEmotionTag(original, DISABLED_STRIP)
  assert.equal(result.visibleText, original)
  assert.equal(result.emotionSource, "disabled")
})

test("null/undefined raw text degrades to empty", () => {
  // @ts-expect-error verifying runtime defensiveness
  const result = parseEmotionTag(null, ENABLED)
  assert.equal(result.visibleText, "")
  assert.equal(result.emotion, "neutral")
  assert.equal(result.emotionSource, "fallback")
})

/* ------------------------------------------------------------------ */
/*  TTS instruction extraction tests                                   */
/* ------------------------------------------------------------------ */

test("extracts TTS instruction from text with emotion tag", () => {
  // TTS instruction comes before the trailing emotion tag
  const input = '你好，主人！\n[[TTS_INSTRUCTION:请用开心的语气说这句话。]]\n<emotion value="happy" />'
  const result = parseEmotionTag(input, ENABLED)
  assert.equal(result.emotion, "happy")
  assert.equal(result.ttsInstruction, "请用开心的语气说这句话。")
  assert.ok(!result.visibleText.includes("[[TTS_INSTRUCTION:"))
  assert.ok(!result.visibleText.includes("<emotion"))
})

test("extracts TTS instruction from text without emotion tag", () => {
  const input = '你好，主人！\n[[TTS_INSTRUCTION:请用温柔的语气说这句话。]]'
  const result = parseEmotionTag(input, ENABLED)
  assert.equal(result.ttsInstruction, "请用温柔的语气说这句话。")
  assert.equal(result.visibleText, "你好，主人！")
})

test("extracts first TTS instruction when multiple present", () => {
  const input = '你好\n[[TTS_INSTRUCTION:第一条指令]]\n再见\n[[TTS_INSTRUCTION:第二条指令]]'
  const result = parseEmotionTag(input, ENABLED)
  assert.equal(result.ttsInstruction, "第一条指令")
  assert.ok(!result.visibleText.includes("[[TTS_INSTRUCTION:"))
})

test("no TTS instruction when tag not present", () => {
  const input = '你好，主人！\n<emotion value="happy" />'
  const result = parseEmotionTag(input, ENABLED)
  assert.equal(result.ttsInstruction, undefined)
})

test("TTS instruction extraction works with disabled emotion", () => {
  const input = '你好，主人！\n[[TTS_INSTRUCTION:请用开心的语气说这句话。]]'
  const result = parseEmotionTag(input, DISABLED_STRIP)
  assert.equal(result.ttsInstruction, "请用开心的语气说这句话。")
  assert.equal(result.visibleText, "你好，主人！")
})
