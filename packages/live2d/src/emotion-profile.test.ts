import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_LIVE2D_EMOTION_PROFILE,
  resolveEmotionBinding,
  type Live2DEmotionProfile,
} from "./emotion-profile.js"
import type { Emotion } from "@live2d-agent/shared"

test("emotion=happy returns the happy binding", () => {
  const profile: Live2DEmotionProfile = {
    happy: { motion: "IDLE", expression: "爱心眼" },
  }
  const binding = resolveEmotionBinding(profile, "happy")
  assert.deepEqual(binding, { motion: "IDLE", expression: "爱心眼" })
})

test("missing emotion falls back to neutral", () => {
  const profile: Live2DEmotionProfile = {
    neutral: { motion: "IDLE", expression: "默认" },
  }
  const binding = resolveEmotionBinding(profile, "sad")
  assert.deepEqual(binding, { motion: "IDLE", expression: "默认" })
})

test("missing emotion and missing neutral returns undefined", () => {
  const binding = resolveEmotionBinding({}, "scared")
  assert.equal(binding, undefined)
})

test("neutral itself, when missing, returns undefined", () => {
  const binding = resolveEmotionBinding({}, "neutral")
  assert.equal(binding, undefined)
})

test("profile can be empty (no motion, no expression)", () => {
  const profile: Live2DEmotionProfile = { happy: {} }
  const binding = resolveEmotionBinding(profile, "happy")
  assert.deepEqual(binding, {})
})

test("default profile covers every emotion", () => {
  const emotions: Emotion[] = [
    "neutral", "happy", "sad", "angry", "surprised",
    "thinking", "embarrassed", "scared", "confused",
    "tired", "love", "speechless",
  ]
  for (const emotion of emotions) {
    const binding = resolveEmotionBinding(DEFAULT_LIVE2D_EMOTION_PROFILE, emotion)
    assert.ok(binding, `default profile must include ${emotion}`)
  }
})
