import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_TTS_EMOTION_INSTRUCTIONS,
  composeTtsNaturalEmotionInstruction,
} from "./emotion.js"

test("default TTS emotion instructions do not include generic assistant role text", () => {
  for (const instruction of Object.values(DEFAULT_TTS_EMOTION_INSTRUCTIONS)) {
    assert.equal(instruction.includes("You are a helpful assistant."), false)
  }
})

test("default TTS emotion instructions include restrained intensity guidance", () => {
  const allInstructions = Object.values(DEFAULT_TTS_EMOTION_INSTRUCTIONS).join("\n")
  assert.match(allInstructions, /轻度|中度/)
  assert.ok(DEFAULT_TTS_EMOTION_INSTRUCTIONS.happy.includes("轻度"))
  assert.ok(DEFAULT_TTS_EMOTION_INSTRUCTIONS.surprised.includes("中度"))
  assert.ok(DEFAULT_TTS_EMOTION_INSTRUCTIONS.love.includes("中度"))
})

test("default TTS emotion instructions stay concise for instruct API", () => {
  for (const instruction of Object.values(DEFAULT_TTS_EMOTION_INSTRUCTIONS)) {
    assert.ok(instruction.length <= 18, instruction)
    assert.match(instruction, /语速/)
  }
})

test("composeTtsNaturalEmotionInstruction returns compact emotion instruction only", () => {
  assert.equal(
    composeTtsNaturalEmotionInstruction("轻度的活泼开心，语速稍快。"),
    "轻度的活泼开心，语速稍快",
  )
})

test("composeTtsNaturalEmotionInstruction falls back to neutral instruction", () => {
  assert.equal(composeTtsNaturalEmotionInstruction("  "), DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral)
  assert.equal(composeTtsNaturalEmotionInstruction(undefined), DEFAULT_TTS_EMOTION_INSTRUCTIONS.neutral)
})

test("composeTtsNaturalEmotionInstruction compacts long LLM-controlled instructions", () => {
  const instruction = composeTtsNaturalEmotionInstruction(
    "请加入轻度的活泼开心，语速稍快，不要夸张，说这句话。",
  )

  assert.ok(instruction.startsWith("轻度的活泼开心"))
  assert.ok(instruction.length <= 18, instruction)
  assert.equal(instruction.includes("请"), false)
  assert.equal(instruction.includes("保持音色"), false)
})
