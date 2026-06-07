import { readdirSync } from "node:fs"
import { basename, dirname } from "node:path"

type JsonObject = Record<string, unknown>

interface Live2DExpressionReference {
  Name: string
  File: string
}

interface Live2DMotionReference {
  File: string
}

const EXPRESSION_ALIASES: Record<string, string[]> = {
  happy: ["爱心眼"],
  sad: ["伤心"],
  angry: ["生气"],
  surprised: ["呆呆脸"],
  thinking: ["问号"],
  embarrassed: ["脸红"],
  scared: ["害怕"],
  confused: ["问号"],
  tired: ["晕晕脸"],
  love: ["爱心眼"],
  speechless: ["无语"],
}

export function patchLive2DModelJsonFileReferences(modelJson: unknown, modelPath: string): unknown {
  if (!isObject(modelJson)) return modelJson

  const fileReferences = isObject(modelJson.FileReferences)
    ? { ...modelJson.FileReferences }
    : {}

  const modelDir = dirname(modelPath)
  let changed = false

  const expressions = mergeExpressions(fileReferences.Expressions, modelDir)
  if (expressions.changed) {
    fileReferences.Expressions = expressions.value
    changed = true
  }

  const motions = mergeMotions(fileReferences.Motions, modelDir)
  if (motions.changed) {
    fileReferences.Motions = motions.value
    changed = true
  }

  if (!changed) return modelJson
  return {
    ...modelJson,
    FileReferences: fileReferences,
  }
}

function mergeExpressions(existing: unknown, modelDir: string): { value: Live2DExpressionReference[]; changed: boolean } {
  const current = Array.isArray(existing)
    ? existing.filter(isExpressionReference).map((item) => ({ ...item }))
    : []
  const existingNames = new Set(current.map((item) => item.Name))
  const files = listFilesByExtension(modelDir, ".exp3.json")
  let changed = !Array.isArray(existing) && files.length > 0

  const fileByName = new Map<string, string>()
  for (const file of files) {
    const name = stripSuffix(file, ".exp3.json")
    fileByName.set(name, file)
    if (!existingNames.has(name)) {
      current.push({ Name: name, File: file })
      existingNames.add(name)
      changed = true
    }
  }

  for (const [alias, candidates] of Object.entries(EXPRESSION_ALIASES)) {
    if (existingNames.has(alias)) continue
    const file = candidates.map((candidate) => fileByName.get(candidate)).find(Boolean)
    if (!file) continue
    current.push({ Name: alias, File: file })
    existingNames.add(alias)
    changed = true
  }

  return { value: current, changed }
}

function mergeMotions(existing: unknown, modelDir: string): { value: Record<string, Live2DMotionReference[]>; changed: boolean } {
  const current = isObject(existing) ? cloneMotionReferences(existing) : {}
  const files = listFilesByExtension(modelDir, ".motion3.json")
  let changed = !isObject(existing) && files.length > 0

  for (const file of files) {
    const group = motionGroupName(file)
    if (current[group]?.length) continue
    current[group] = [{ File: file }]
    changed = true
  }

  return { value: current, changed }
}

function cloneMotionReferences(value: JsonObject): Record<string, Live2DMotionReference[]> {
  const result: Record<string, Live2DMotionReference[]> = {}
  for (const [group, references] of Object.entries(value)) {
    if (!Array.isArray(references)) continue
    const validReferences = references.filter(isMotionReference).map((item) => ({ ...item }))
    if (validReferences.length > 0) result[group] = validReferences
  }
  return result
}

function listFilesByExtension(dir: string, extension: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function motionGroupName(file: string): string {
  const raw = stripSuffix(file, ".motion3.json").replace(/_\d+$/, "")
  if (/^[A-Z0-9_ -]+$/.test(raw)) return raw.toLowerCase()
  return raw
}

function stripSuffix(value: string, suffix: string): string {
  return basename(value).slice(0, -suffix.length)
}

function isExpressionReference(value: unknown): value is Live2DExpressionReference {
  return isObject(value) && typeof value.Name === "string" && typeof value.File === "string"
}

function isMotionReference(value: unknown): value is Live2DMotionReference {
  return isObject(value) && typeof value.File === "string"
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
