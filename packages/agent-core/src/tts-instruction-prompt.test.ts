import { test } from "node:test"
import assert from "node:assert/strict"
import {
  getTtsInstructionPrompt,
  isTtsInstructionInjected,
  TTS_INSTRUCTION_MARKER,
} from "./tts-instruction-prompt.js"

test("getTtsInstructionPrompt returns a non-empty string", () => {
  const prompt = getTtsInstructionPrompt()
  assert.ok(prompt.length > 0)
  assert.ok(prompt.includes("TTS_INSTRUCTION"))
})

test("TTS_INSTRUCTION_MARKER is the expected prefix", () => {
  assert.equal(TTS_INSTRUCTION_MARKER, "[[TTS_INSTRUCTION:")
})

test("isTtsInstructionInjected returns true when marker is present", () => {
  const prompt = "Some prompt\n\n" + getTtsInstructionPrompt()
  assert.equal(isTtsInstructionInjected(prompt), true)
})

test("isTtsInstructionInjected returns false when marker is absent", () => {
  assert.equal(isTtsInstructionInjected("Just a plain prompt"), false)
})

test("isTtsInstructionInjected returns false for undefined input", () => {
  assert.equal(isTtsInstructionInjected(undefined), false)
})

test("isTtsInstructionInjected returns false for empty string", () => {
  assert.equal(isTtsInstructionInjected(""), false)
})

test("prompt contains the required format instructions", () => {
  const prompt = getTtsInstructionPrompt()
  assert.ok(prompt.includes("[[TTS_INSTRUCTION:这里填写一句中文自然语言朗读指令]]"))
  assert.ok(prompt.includes("10~50 个中文字符"))
})
