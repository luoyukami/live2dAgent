import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { patchLive2DModelJsonFileReferences } from "./live2d-model-json.js"

test("patchLive2DModelJsonFileReferences adds missing expressions and motions", () => {
  const dir = mkdtempSync(join(tmpdir(), "live2d-model-json-"))
  try {
    writeFileSync(join(dir, "爱心眼.exp3.json"), "{}")
    writeFileSync(join(dir, "伤心.exp3.json"), "{}")
    writeFileSync(join(dir, "IDLE.motion3.json"), "{}")

    const modelPath = join(dir, "model.model3.json")
    const patched = patchLive2DModelJsonFileReferences({
      Version: 3,
      FileReferences: {
        Moc: "model.moc3",
        Textures: ["texture.png"],
      },
    }, modelPath)

    assert.deepEqual(expressionByName(patched, "爱心眼"), { Name: "爱心眼", File: "爱心眼.exp3.json" })
    assert.deepEqual(expressionByName(patched, "happy"), { Name: "happy", File: "爱心眼.exp3.json" })
    assert.deepEqual(expressionByName(patched, "sad"), { Name: "sad", File: "伤心.exp3.json" })
    assert.deepEqual(motionGroups(patched), { idle: [{ File: "IDLE.motion3.json" }] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("patchLive2DModelJsonFileReferences preserves existing references", () => {
  const dir = mkdtempSync(join(tmpdir(), "live2d-model-json-"))
  try {
    writeFileSync(join(dir, "爱心眼.exp3.json"), "{}")
    writeFileSync(join(dir, "IDLE.motion3.json"), "{}")

    const patched = patchLive2DModelJsonFileReferences({
      Version: 3,
      FileReferences: {
        Expressions: [{ Name: "happy", File: "custom.exp3.json" }],
        Motions: { idle: [{ File: "custom.motion3.json" }] },
      },
    }, join(dir, "model.model3.json"))

    assert.deepEqual(expressionByName(patched, "happy"), { Name: "happy", File: "custom.exp3.json" })
    assert.deepEqual(expressionByName(patched, "爱心眼"), { Name: "爱心眼", File: "爱心眼.exp3.json" })
    assert.deepEqual(motionGroups(patched), { idle: [{ File: "custom.motion3.json" }] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function expressionByName(modelJson: unknown, name: string): unknown {
  const refs = fileReferences(modelJson)
  const expressions = refs.Expressions
  assert.ok(Array.isArray(expressions))
  return expressions.find((expression) => expression.Name === name)
}

function motionGroups(modelJson: unknown): unknown {
  return fileReferences(modelJson).Motions
}

function fileReferences(modelJson: unknown): Record<string, any> {
  assert.ok(modelJson && typeof modelJson === "object" && "FileReferences" in modelJson)
  return (modelJson as { FileReferences: Record<string, any> }).FileReferences
}
