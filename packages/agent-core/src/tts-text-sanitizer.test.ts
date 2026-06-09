import { test } from "node:test"
import assert from "node:assert/strict"
import { sanitizeTextForTts, extractTtsInstruction } from "./tts-text-sanitizer.js"

/* ------------------------------------------------------------------ */
/*  sanitizeTextForTts                                                 */
/* ------------------------------------------------------------------ */

test("sanitizeTextForTts removes emotion tags", () => {
  const input = '你好，主人！\n<emotion value="happy" />'
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好，主人！")
})

test("sanitizeTextForTts removes TTS instruction tags", () => {
  const input = '你好，主人！\n[[TTS_INSTRUCTION:请用开心的语气说这句话。]]'
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好，主人！")
})

test("sanitizeTextForTts removes both emotion and TTS tags", () => {
  const input = '你好，主人！\n<emotion value="happy" />\n[[TTS_INSTRUCTION:请用开心的语气说这句话。]]'
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好，主人！")
})

test("sanitizeTextForTts converts markdown links to title only", () => {
  const input = "请查看[这个文档](https://example.com)了解更多。"
  const result = sanitizeTextForTts(input)
  assert.equal(result, "请查看这个文档了解更多。")
})

test("sanitizeTextForTts replaces long code blocks with placeholder", () => {
  const longCode = "```javascript\n" + "x".repeat(250) + "\n```"
  const input = `这是代码：\n${longCode}\n结束。`
  const result = sanitizeTextForTts(input)
  assert.ok(result.includes("我给你写了一段代码，具体内容请看屏幕。"))
  assert.ok(result.includes("这是代码："))
  assert.ok(result.includes("结束。"))
})

test("sanitizeTextForTts removes short code blocks entirely", () => {
  const shortCode = "```js\nconst x = 1;\n```"
  const input = `这是代码：\n${shortCode}\n结束。`
  const result = sanitizeTextForTts(input)
  assert.ok(!result.includes("const x = 1"))
  assert.ok(result.includes("这是代码："))
  assert.ok(result.includes("结束。"))
})

test("sanitizeTextForTts trims extra blank lines", () => {
  const input = "你好\n\n\n\n\n主人"
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好\n\n主人")
})

test("sanitizeTextForTts handles empty input", () => {
  assert.equal(sanitizeTextForTts(""), "")
  assert.equal(sanitizeTextForTts("  \n  "), "")
})

test("sanitizeTextForTts preserves normal punctuation and Chinese text", () => {
  const input = "你好，主人！今天天气怎么样？我很开心。"
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好，主人！今天天气怎么样？我很开心。")
})

/* ------------------------------------------------------------------ */
/*  extractTtsInstruction                                              */
/* ------------------------------------------------------------------ */

test("extractTtsInstruction extracts instruction and cleans text", () => {
  const input = '你好，主人！\n[[TTS_INSTRUCTION:请用开心的语气说这句话。]]'
  const result = extractTtsInstruction(input)
  assert.notEqual(result, null)
  assert.equal(result!.instruction, "请用开心的语气说这句话。")
  assert.equal(result!.cleanedText, "你好，主人！")
})

test("extractTtsInstruction handles multiple TTS tags (uses first one)", () => {
  const input = '你好\n[[TTS_INSTRUCTION:第一条指令]]\n再见\n[[TTS_INSTRUCTION:第二条指令]]'
  const result = extractTtsInstruction(input)
  assert.notEqual(result, null)
  assert.equal(result!.instruction, "第一条指令")
  // All TTS tags should be removed from cleanedText
  assert.ok(!result!.cleanedText.includes("[[TTS_INSTRUCTION:"))
})

test("extractTtsInstruction returns null when no tag found", () => {
  const input = "你好，主人！"
  const result = extractTtsInstruction(input)
  assert.equal(result, null)
})

test("extractTtsInstruction truncates long instructions to 100 chars", () => {
  const longInstruction = "这是一条非常长的指令".repeat(10)
  const input = `你好\n[[TTS_INSTRUCTION:${longInstruction}]]`
  const result = extractTtsInstruction(input)
  assert.notEqual(result, null)
  assert.ok(result!.instruction.length <= 100)
})

test("extractTtsInstruction handles empty input", () => {
  assert.equal(extractTtsInstruction(""), null)
  assert.equal(extractTtsInstruction("  "), null)
})

test("extractTtsInstruction trims instruction whitespace", () => {
  const input = '你好\n[[TTS_INSTRUCTION:  请用开心的语气  ]]'
  const result = extractTtsInstruction(input)
  assert.notEqual(result, null)
  assert.equal(result!.instruction, "请用开心的语气")
})
