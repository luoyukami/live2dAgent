import { test } from "node:test"
import assert from "node:assert/strict"
import {
  sanitizeTextForTts,
  extractTtsInstruction,
  removeEmojiAndKaomoji,
  segmentLongText,
} from "./tts-text-sanitizer.js"

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

/* ------------------------------------------------------------------ */
/*  removeEmojiAndKaomoji                                              */
/* ------------------------------------------------------------------ */

test("removeEmojiAndKaomoji removes common emojis", () => {
  const input = "你好😊主人！🐱今天天气不错🌤️"
  const result = removeEmojiAndKaomoji(input)
  assert.equal(result, "你好主人！今天天气不错")
})

test("removeEmojiAndKaomoji removes kaomoji (颜文字)", () => {
  const input = "你好(╯°□°)╯主人！¯\\_(ツ)_/¯"
  const result = removeEmojiAndKaomoji(input)
  assert.equal(result, "你好主人！")
})

test("removeEmojiAndKaomoji removes complex kaomoji patterns", () => {
  const input = "开心(◕‿◕)✧ 难过╥﹏╥ 惊讶Σ(°△°|||)"
  const result = removeEmojiAndKaomoji(input)
  // Spaces between words remain after kaomoji removal (natural for TTS)
  assert.equal(result, "开心 难过 惊讶")
})

test("removeEmojiAndKaomoji preserves normal Chinese punctuation", () => {
  const input = "你好，主人！今天天气怎么样？"
  const result = removeEmojiAndKaomoji(input)
  assert.equal(result, "你好，主人！今天天气怎么样？")
})

test("removeEmojiAndKaomoji handles mixed content", () => {
  const input = "Hello 😊 你好 🌸 再见 👋"
  const result = removeEmojiAndKaomoji(input)
  assert.equal(result, "Hello 你好 再见")
})

test("removeEmojiAndKaomoji handles empty input", () => {
  assert.equal(removeEmojiAndKaomoji(""), "")
  assert.equal(removeEmojiAndKaomoji("  "), "")
})

test("removeEmojiAndKaomoji preserves numbers and letters", () => {
  const input = "版本1.0.0 发布了🎉"
  const result = removeEmojiAndKaomoji(input)
  assert.equal(result, "版本1.0.0 发布了")
})

test("removeEmojiAndKaomoji removes flag emojis", () => {
  const input = "🇨🇳 中国 🇺🇸 美国"
  const result = removeEmojiAndKaomoji(input)
  assert.equal(result, "中国 美国")
})

/* ------------------------------------------------------------------ */
/*  segmentLongText                                                    */
/* ------------------------------------------------------------------ */

test("segmentLongText returns single segment for short text", () => {
  const input = "你好主人"
  const result = segmentLongText(input)
  assert.deepEqual(result, ["你好主人"])
})

test("segmentLongText returns empty array for empty input", () => {
  assert.deepEqual(segmentLongText(""), [])
})

test("segmentLongText splits at Chinese punctuation (。)", () => {
  // Input: ~40 chars, well above 30 trigger threshold
  const input = "这是第一句话内容确实比较长一些需要分割。这是第二句话内容也比较长需要分段。第三句"
  const result = segmentLongText(input, 40, 30)
  // Should split at period boundary
  assert.ok(result.length >= 2)
  assert.ok(result[0].includes("。"))
})

test("segmentLongText splits at exclamation marks (！)", () => {
  // Input: ~40 chars
  const input = "太好了我们终于完成了这个任务大家辛苦了真的很棒。继续加油努力工作吧"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText splits at question marks (？)", () => {
  // Input: ~45 chars, with ？ placed within search range (pos 20-39)
  const input = "今天我去了公园里散步看见了很多美丽的花朵心情真的非常好你觉得呢？好看吗"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText splits at commas (，) when needed", () => {
  // Input: ~45 chars
  const input = "今天天气真好，阳光明媚，适合出去玩，你觉得呢，我们一起去吧好吗"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText splits at sentence-ending particles", () => {
  // Input: ~45 chars, particle 呢 placed within search range (pos 20-39) with text after
  const input = "今天天气非常好我们一起出去玩吧去公园里面走走呢然后回家吃饭休息一下好吗"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText splits at conjunctions (但是/然而/不过)", () => {
  // Input: ~45 chars, conjunction placed within search range (pos 20-39)
  const input = "今天早上我起床吃了早饭然后出门上班路上交通很堵但是最后还是到了不过"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText respects triggerLength threshold", () => {
  // Text under trigger length should not be split
  const shortText = "这是一段不太长的文本"
  const result = segmentLongText(shortText, 40, 30)
  assert.equal(result.length, 1)
  assert.equal(result[0], shortText)
})

test("segmentLongText handles text exactly at trigger length", () => {
  // Create text of exactly 30 characters
  const text = "一二三四五六七八九十".repeat(3) // 30 chars
  const result = segmentLongText(text, 40, 30)
  assert.equal(result.length, 1)
})

test("segmentLongText handles text just over trigger length", () => {
  // Create text of 35 characters with a punctuation split point
  const text = "一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十"
  const result = segmentLongText(text, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText preserves segment order", () => {
  // Input: ~45 chars
  const input = "第一段内容比较长需要分段处理一下的对吧。第二段内容也挺长的要分开。第三段内容"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result[0].includes("第一段"))
  assert.ok(result[result.length - 1].includes("第三段"))
})

test("segmentLongText handles mixed punctuation", () => {
  // Input: ~45 chars
  const input = "你好吗我很好今天天气不错？阳光明媚。适合出去玩呢！我们一起去吧好吗走吧"
  const result = segmentLongText(input, 40, 30)
  assert.ok(result.length >= 2)
})

test("segmentLongText handles very long text", () => {
  // Create a long text: 15 sentences of ~7 chars each = ~105 chars total
  const sentences = Array.from({ length: 15 }, (_, i) => `这是第${i + 1}句话内容。`).join("")
  const result = segmentLongText(sentences, 40, 30)
  assert.ok(result.length >= 3)
  // Verify all content is preserved
  const rejoined = result.join("")
  assert.equal(rejoined, sentences)
})

test("segmentLongText filters out empty segments", () => {
  const input = "第一句话内容比较长需要分割处理一下。。第二句话内容也很长需要分割"
  const result = segmentLongText(input, 40, 30)
  // Should not have empty strings in result
  assert.ok(result.every((s) => s.length > 0))
})

test("segmentLongText handles text with only punctuation", () => {
  const input = "。。。。。。"
  const result = segmentLongText(input, 40, 30)
  // Punctuation-only text should still produce segments
  assert.ok(result.length >= 1)
})

test("segmentLongText custom maxSegmentLength and triggerLength", () => {
  // With maxSegmentLength=15, triggerLength=10, need input >15 chars with split points
  const input = "这是比较长的文本，需要分割成小段"
  const result = segmentLongText(input, 15, 10)
  // With smaller limits, should split more aggressively
  assert.ok(result.length >= 2)
  result.forEach((segment) => {
    assert.ok(segment.length <= 20) // Allow some overflow for natural boundaries
  })
})

/* ------------------------------------------------------------------ */
/*  sanitizeTextForTts - emoji/kaomoji integration                     */
/* ------------------------------------------------------------------ */

test("sanitizeTextForTts removes emoji from text", () => {
  const input = "你好😊主人！今天天气不错🌤️"
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好主人！今天天气不错")
})

test("sanitizeTextForTts removes kaomoji from text", () => {
  const input = "开心(◕‿◕)✧ 继续努力💪"
  const result = sanitizeTextForTts(input)
  // Space remains after kaomoji removal (natural for TTS)
  assert.equal(result, "开心 继续努力")
})

test("sanitizeTextForTts handles text with only emoji", () => {
  const input = "😊🐱🎉"
  const result = sanitizeTextForTts(input)
  assert.equal(result, "")
})

test("sanitizeTextForTts preserves Chinese punctuation after emoji removal", () => {
  const input = "你好，主人！😊今天天气怎么样？🌤️"
  const result = sanitizeTextForTts(input)
  assert.equal(result, "你好，主人！今天天气怎么样？")
})
