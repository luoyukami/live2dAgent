import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_EMOTION_SETTINGS,
  DEFAULT_VOICE_INPUT_SETTINGS,
  isEmotion,
  type AgentMode,
  type AppSettings,
  type AppSettingsPublicPatch,
  type Emotion,
  type EmotionSettings,
  type EmotionSettingsPatch,
  type Live2DEmotionProfile,
  type Live2DEmotionBinding,
  type Live2DSettings,
  type Live2DSettingsPatch,
  type UiSettings,
  type AgentSettings,
  type PermissionSettings,
  type PublicSettings,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "@live2d-agent/shared"

/* ------------------------------------------------------------------ */
/*  Defaults                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_LIVE2D_SETTINGS: Live2DSettings = {
  modelPath: "",
  scale: 1,
  x: 0,
  y: 0,
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  alwaysOnTop: true,
  opacity: 1,
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxSteps: 20,
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  mode: "permissive",
}

export function createDefaultSettings(userDataDir: string): AppSettings {
  const workspaceDir = join(userDataDir, "workspace")
  mkdirSync(workspaceDir, { recursive: true })

  const localDevSettings = readLocalDevSettings()

  return {
    mode: readEnvAgentMode() ?? localDevSettings.mode ?? "confirm",
    workspaceDir,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? localDevSettings.openaiBaseUrl ?? "https://api.openai.com/v1",
    openaiModel: process.env.OPENAI_MODEL ?? localDevSettings.openaiModel ?? "gpt-4o-mini",
    openaiApiKey: process.env.OPENAI_API_KEY ?? localDevSettings.openaiApiKey,
    live2d: { ...DEFAULT_LIVE2D_SETTINGS },
    ui: { ...DEFAULT_UI_SETTINGS },
    agent: { ...DEFAULT_AGENT_SETTINGS },
    permissions: { ...DEFAULT_PERMISSION_SETTINGS, ...(localDevSettings.permissions ?? {}) },
    emotion: { ...DEFAULT_EMOTION_SETTINGS },
    voice: { ...DEFAULT_VOICE_INPUT_SETTINGS },
  }
}

/* ------------------------------------------------------------------ */
/*  Local development config                                           */
/* ------------------------------------------------------------------ */

type LocalDevSettings = Partial<Pick<AppSettings, "mode" | "openaiBaseUrl" | "openaiModel" | "openaiApiKey">> & {
  permissions?: Partial<PermissionSettings>
}

function isDevEnvironment(): boolean {
  return process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL !== undefined
}

function readEnvAgentMode(): AgentMode | undefined {
  return isAgentMode(process.env.AGENT_MODE) ? process.env.AGENT_MODE : undefined
}

function readLocalDevSettings(): LocalDevSettings {
  if (!isDevEnvironment()) return {}

  const configPath = findLocalConfigPath()
  if (!configPath) return {}

  try {
    return parseLocalDevSettings(readFileSync(configPath, "utf8"))
  } catch {
    return {}
  }
}

function findLocalConfigPath(): string | null {
  const candidates = getRepoRootCandidates()

  for (const root of candidates) {
    const configPath = join(root, "local", "config.yaml")
    if (existsSync(configPath)) return configPath
  }

  return null
}

function getRepoRootCandidates(): string[] {
  const candidates = [process.cwd(), resolve(process.cwd(), "..", "..")]

  try {
    const modulePath = fileURLToPath(import.meta.url)
    candidates.push(resolve(dirname(modulePath), "..", "..", "..", ".."))
    candidates.push(resolve(dirname(modulePath), "..", "..", ".."))
  } catch {
    /* ignore – import.meta.url may not be available */
  }

  return candidates
}

function parseLocalDevSettings(yaml: string): LocalDevSettings {
  const parsed: Record<string, string> = {}
  let inSettings = false

  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    if (/^settings\s*:\s*$/.test(trimmed)) {
      inSettings = true
      continue
    }

    if (!inSettings) continue
    if (!/^\s+/.test(line)) break

    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/)
    if (!match) continue

    parsed[match[1]] = unquoteYamlScalar(match[2].trim())
  }

  const settings: LocalDevSettings = {}
  if (isAgentMode(parsed.mode)) settings.mode = parsed.mode
  if (parsed.openaiBaseUrl) settings.openaiBaseUrl = parsed.openaiBaseUrl
  if (parsed.openaiModel) settings.openaiModel = parsed.openaiModel
  if (parsed.openaiApiKey) settings.openaiApiKey = parsed.openaiApiKey
  if (isPermissionMode(parsed.permissionMode)) settings.permissions = { mode: parsed.permissionMode }
  return settings
}

function unquoteYamlScalar(value: string): string {
  const isQuoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  if (value.length >= 2 && isQuoted) {
    return value.slice(1, -1)
  }
  return value
}

/* ------------------------------------------------------------------ */
/*  Deep-merge helpers                                                */
/* ------------------------------------------------------------------ */

function deepMergeDefaults(parsed: Record<string, unknown>, defaults: AppSettings): AppSettings {
  const parsedLive2d = (parsed.live2d ?? {}) as Partial<Live2DSettings>
  // Strip `emotionProfile` from the raw parsed payload BEFORE spreading it
  // into the live2d object. The sanitizer below decides whether a cleaned
  // version of the profile should be added back. Spreading the raw value
  // first would let a malformed profile leak into the merged result.
  const { emotionProfile: _drop, ...safeParsedLive2d } = parsedLive2d
  const sanitizedProfile = sanitizeEmotionProfile(parsedLive2d.emotionProfile)
  return {
    ...defaults,
    ...parsed,
    // Nested objects: merge each level with defaults so missing keys don't drop defaults
    live2d: {
      ...defaults.live2d,
      ...safeParsedLive2d,
      ...(sanitizedProfile !== undefined ? { emotionProfile: sanitizedProfile } : {}),
    },
    ui: { ...defaults.ui, ...((parsed.ui ?? {}) as Partial<UiSettings>) },
    agent: { ...defaults.agent, ...((parsed.agent ?? {}) as Partial<AgentSettings>) },
    permissions: { ...defaults.permissions, ...((parsed.permissions ?? {}) as Partial<PermissionSettings>) },
    emotion: mergeEmotionSettings(
      (parsed.emotion ?? {}) as Partial<EmotionSettings>,
      defaults.emotion,
    ),
    voice: {
      ...defaults.voice,
      ...((parsed.voice ?? {}) as Partial<VoiceInputSettings>),
    },
  }
}

/**
 * Merge persisted emotion settings with defaults, enforcing the invariant
 * that disabling the master switch forces the prompt injection off too.
 */
function mergeEmotionSettings(
  parsed: Partial<EmotionSettings>,
  defaults: EmotionSettings,
): EmotionSettings {
  const enabled = pickBoolean(parsed.enabled, defaults.enabled)
  return {
    enabled,
    injectPrompt: enabled ? pickBoolean(parsed.injectPrompt, defaults.injectPrompt) : false,
    defaultEmotion: pickEmotion(parsed.defaultEmotion, defaults.defaultEmotion),
    stripTagWhenDisabled: pickBoolean(parsed.stripTagWhenDisabled, defaults.stripTagWhenDisabled),
  }
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function pickEmotion(value: unknown, fallback: Emotion): Emotion {
  return isEmotion(value) ? value : fallback
}

/**
 * Strict type guard: `true` only when EVERY key and binding is well-formed.
 * Use this when you need to know that the input can be assigned to
 * `Live2DEmotionProfile` as-is without modification.
 *
 * For "trust the user, just clean it up" behaviour, use `sanitizeEmotionProfile`.
 */
function isValidEmotionProfile(value: unknown): value is Live2DEmotionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  for (const [key, binding] of Object.entries(obj)) {
    if (!isEmotion(key)) return false
    if (binding === null) continue
    if (typeof binding !== "object") return false
    const b = binding as Record<string, unknown>
    if (b.motion !== undefined && typeof b.motion !== "string") return false
    if (b.expression !== undefined && typeof b.expression !== "string") return false
    if (b.motionIndex !== undefined && (!Number.isInteger(b.motionIndex) || (b.motionIndex as number) < 0)) return false
    if (b.priority !== undefined && typeof b.priority !== "number") return false
  }
  return true
}

/**
 * Per-key sanitizer for an `emotionProfile` payload.
 *
 * Behaviour:
 *  - Non-object input (including arrays, primitives, null) → returns `undefined`.
 *  - Unknown emotion keys are silently dropped.
 *  - Each binding is rebuilt from scratch, copying only fields whose type is
 *    valid (`motion` / `expression` must be strings, `motionIndex` must be a
 *    non-negative integer, `priority` must be a finite number). Anything else
 *    is dropped.
 *  - An entry with `null` value is treated as an explicit clear and dropped.
 *  - Returns `undefined` (NOT an empty object) when the input had no usable
 *    entries. This lets the patch path treat "user sent a fully-malformed
 *    profile" and "user sent no profile at all" identically, so the existing
 *    valid profile is never wiped by a bad payload.
 *
 * This keeps hand-edited `settings.json` from breaking the app: one bad
 * field on an entry no longer wipes out the entry, and a fully-bad entry
 * no longer wipes out the whole profile.
 */
function sanitizeEmotionProfile(value: unknown): Live2DEmotionProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const result: Live2DEmotionProfile = {}
  for (const [key, raw] of Object.entries(obj)) {
    if (!isEmotion(key)) continue
    if (raw === null || raw === undefined) continue
    if (typeof raw !== "object") continue
    const b = raw as Record<string, unknown>
    const cleaned: Live2DEmotionBinding = {}
    if (typeof b.motion === "string") cleaned.motion = b.motion
    if (typeof b.expression === "string") cleaned.expression = b.expression
    if (Number.isInteger(b.motionIndex) && (b.motionIndex as number) >= 0) {
      cleaned.motionIndex = b.motionIndex as number
    }
    if (typeof b.priority === "number" && Number.isFinite(b.priority)) {
      cleaned.priority = b.priority
    }
    // Drop the entry entirely when no field survived sanitization. This
    // prevents empty `{}` bindings from leaking into the renderer.
    if (Object.keys(cleaned).length === 0) continue
    result[key] = cleaned
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Apply an emotion patch on top of the current settings, enforcing the
 * "master switch ⇒ prompt injection" invariant. Unlike `mergeEmotionSettings`,
 * this function knows which fields were *explicitly* provided in the patch.
 *
 * Rules:
 *  - Master switch ON  + patch did NOT specify injectPrompt  ⇒ injectPrompt = true
 *  - Master switch OFF                                         ⇒ injectPrompt = false
 *  - Master switch ON  + patch explicitly set injectPrompt     ⇒ honour the value
 */
function applyEmotionPatch(
  current: EmotionSettings,
  patch: Partial<EmotionSettings>,
): EmotionSettings {
  const merged: EmotionSettings = { ...current, ...patch }
  if (!merged.enabled) {
    merged.injectPrompt = false
  } else if (patch.injectPrompt === undefined) {
    merged.injectPrompt = true
  }
  return merged
}

/* ------------------------------------------------------------------ */
/*  Validation helpers                                                */
/* ------------------------------------------------------------------ */

function isAgentMode(v: unknown): v is AgentMode {
  return v === "manual" || v === "confirm" || v === "auto"
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function isPermissionMode(v: unknown): v is PermissionSettings["mode"] {
  return v === "ask" || v === "permissive"
}

function numberInRange(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!isNumber(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`)
  }
  return value
}

function integerInRange(value: unknown, field: string, min: number, max: number): number | undefined {
  const n = numberInRange(value, field, min, max)
  if (n === undefined) return undefined
  if (!Number.isInteger(n)) throw new Error(`${field} must be an integer between ${min} and ${max}`)
  return n
}

function rejectRemoteLive2DModelPath(modelPath: string): void {
  if (/^https?:\/\//i.test(modelPath.trim())) {
    throw new Error("live2d.modelPath only supports local paths in v0.1")
  }
}

function localModelPathFromSetting(modelPath: string): string | null {
  if (!modelPath || /^https?:\/\//i.test(modelPath)) return null
  if (modelPath.startsWith("file://")) {
    try {
      return fileURLToPath(modelPath)
    } catch {
      return null
    }
  }
  return modelPath
}

/* ------------------------------------------------------------------ */
/*  Local dev model detection                                         */
/* ------------------------------------------------------------------ */

/**
 * Locate the local development Live2D model when `modelPath` is empty.
 * Checks for `local/live2dcubismcore.min.js` and `local/玳瑁猫v1_vts/*.model3.json`.
 * Returns an absolute path to the model JSON, or null if not found.
 */
function findLocalDevModelPath(): string | null {
  const candidates = getRepoRootCandidates()

  for (const root of candidates) {
    const localDir = join(root, "local")
    const coreJs = join(localDir, "live2dcubismcore.min.js")
    const modelDir = join(localDir, "玳瑁猫v1_vts")
    const modelJson = join(modelDir, "玳瑁猫v1_vts.model3.json")
    if (existsSync(coreJs) && existsSync(modelJson)) {
      return modelJson
    }
  }

  return null
}

/* ------------------------------------------------------------------ */
/*  Service                                                           */
/* ------------------------------------------------------------------ */

export class SettingsService {
  private _settings: AppSettings
  private readonly file: string

  constructor(private readonly userDataDir: string) {
    this.file = join(userDataDir, "settings.json")
    mkdirSync(userDataDir, { recursive: true })

    const defaults = createDefaultSettings(userDataDir)

    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>
      this._settings = deepMergeDefaults(raw, defaults)
    } else {
      this._settings = defaults
      this.persist()
    }

    this.applyLocalDevModelFallback()
  }

  reload(): PublicSettings {
    const defaults = createDefaultSettings(this.userDataDir)
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>
      this._settings = deepMergeDefaults(raw, defaults)
    } else {
      this._settings = defaults
      this.persist()
    }
    this.applyLocalDevModelFallback()
    return this.getPublicSettings()
  }

  /** Full settings (internal use only — never expose apiKey to renderer) */
  get(): AppSettings {
    return { ...this._settings }
  }

  /** Public-safe settings — apiKey replaced with hasApiKey boolean */
  getPublicSettings(): PublicSettings {
    const { openaiApiKey: _key, ...rest } = this._settings
    return { ...rest, hasApiKey: Boolean(this._settings.openaiApiKey) }
  }

  /**
   * Apply a low-risk patch (mode, baseUrl, model, live2d, ui, agent).
   * API key and workspaceDir are NOT allowed through this path.
   */
  updatePublicPatch(patch: AppSettingsPublicPatch): void {
    const validated = validatePublicSettingsPatch(patch)
    if (validated.mode !== undefined) this._settings.mode = validated.mode
    if (validated.openaiBaseUrl !== undefined) this._settings.openaiBaseUrl = validated.openaiBaseUrl
    if (validated.openaiModel !== undefined) this._settings.openaiModel = validated.openaiModel
    if (validated.live2d !== undefined) {
      // emotionProfile is a full replacement when present in the patch.
      const next: Live2DSettings = { ...this._settings.live2d, ...validated.live2d }
      if (validated.live2d.emotionProfile === undefined) {
        next.emotionProfile = this._settings.live2d.emotionProfile
      }
      this._settings.live2d = next
    }
    if (validated.ui !== undefined) {
      this._settings.ui = { ...this._settings.ui, ...validated.ui }
    }
    if (validated.agent !== undefined) {
      this._settings.agent = { ...this._settings.agent, ...validated.agent }
    }
    if (validated.permissions !== undefined) {
      this._settings.permissions = { ...this._settings.permissions, ...validated.permissions }
    }
    if (validated.emotion !== undefined) {
      this._settings.emotion = applyEmotionPatch(this._settings.emotion, validated.emotion)
    }
    if (validated.voice !== undefined) {
      this._settings.voice = { ...this._settings.voice, ...validated.voice }
    }
    this.persist()
  }

  /** Update the API key (stored in settings, never returned via getPublicSettings) */
  updateApiKey(apiKey: string): void {
    this._settings.openaiApiKey = apiKey
    this.persist()
  }

  /**
   * Update workspace directory.
   * - Must be a non-empty string.
   * - Resolved to an absolute path.
   * - Directory is created if it doesn't exist.
   */
  updateWorkspaceDir(path: string): void {
    if (!path || typeof path !== "string" || path.trim().length === 0) {
      throw new Error("workspaceDir must be a non-empty string")
    }
    const resolved = resolve(path.trim())
    mkdirSync(resolved, { recursive: true })
    this._settings.workspaceDir = resolved
    this.persist()
  }

  /**
   * Update only the live2d model path.
   * Empty string is allowed (clears the path).
   */
  updateLive2DModelPath(modelPath: string): void {
    if (typeof modelPath !== "string") {
      throw new Error("live2d.modelPath must be a string")
    }
    rejectRemoteLive2DModelPath(modelPath)
    this._settings.live2d.modelPath = modelPath
    this.persist()
  }

  /** Directories that the live2d-local:// protocol may serve. */
  getAllowedLive2DRoots(): string[] {
    const roots = new Set<string>()

    const modelPath = localModelPathFromSetting(this._settings.live2d.modelPath)
    if (modelPath) {
      const modelDir = dirname(resolve(modelPath))
      if (existsSync(modelDir)) roots.add(modelDir)
    }

    const devModel = findLocalDevModelPath()
    if (devModel) roots.add(resolve(dirname(devModel), ".."))

    const packagedModelsDir = join(this.userDataDir, "models", "live2d")
    mkdirSync(packagedModelsDir, { recursive: true })
    roots.add(packagedModelsDir)

    return Array.from(roots).flatMap((root) => {
      try {
        return [realpathSync(root)]
      } catch {
        return []
      }
    })
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this._settings, null, 2), "utf8")
  }

  private applyLocalDevModelFallback(): void {
    if (this._settings.live2d.modelPath) return
    const localModel = findLocalDevModelPath()
    if (!localModel) return
    this._settings.live2d.modelPath = localModel
    this.persist()
  }
}

/* ------------------------------------------------------------------ */
/*  Public patch validator                                            */
/* ------------------------------------------------------------------ */

function validatePublicSettingsPatch(patch: unknown): AppSettingsPublicPatch {
  if (!patch || typeof patch !== "object") return {}
  const input = patch as Record<string, unknown>
  const output: AppSettingsPublicPatch = {}

  if (input.mode !== undefined) {
    if (!isAgentMode(input.mode)) {
      throw new Error(`Invalid agent mode: ${String(input.mode)}`)
    }
    output.mode = input.mode
  }

  if (input.openaiBaseUrl !== undefined) {
    if (typeof input.openaiBaseUrl !== "string" || input.openaiBaseUrl.length === 0) {
      throw new Error("openaiBaseUrl must be a non-empty string")
    }
    output.openaiBaseUrl = input.openaiBaseUrl
  }

  if (input.openaiModel !== undefined) {
    if (typeof input.openaiModel !== "string" || input.openaiModel.length === 0) {
      throw new Error("openaiModel must be a non-empty string")
    }
    output.openaiModel = input.openaiModel
  }

  if (input.live2d !== undefined && typeof input.live2d === "object") {
    const l2d = input.live2d as Record<string, unknown>
    const patch: Live2DSettingsPatch = {}
    const scale = numberInRange(l2d.scale, "live2d.scale", 0.1, 5)
    const x = numberInRange(l2d.x, "live2d.x", -5000, 5000)
    const y = numberInRange(l2d.y, "live2d.y", -5000, 5000)
    if (scale !== undefined) patch.scale = scale
    if (x !== undefined) patch.x = x
    if (y !== undefined) patch.y = y
    if (l2d.emotionProfile !== undefined) {
      // Sanitize per-key so hand-edited payloads with one bad entry don't
      // get rejected wholesale. A non-object input is treated as "no
      // profile" and the key is dropped from the patch (the existing
      // profile is preserved by updatePublicPatch).
      const sanitized = sanitizeEmotionProfile(l2d.emotionProfile)
      if (sanitized !== undefined) {
        patch.emotionProfile = sanitized
      }
    }
    // modelPath is NOT allowed through public patch (sensitive local path)
    if (Object.keys(patch).length > 0) output.live2d = patch
  }

  if (input.ui !== undefined && typeof input.ui === "object") {
    const ui = input.ui as Record<string, unknown>
    const patch: Partial<UiSettings> = {}
    if (ui.alwaysOnTop !== undefined && typeof ui.alwaysOnTop === "boolean") patch.alwaysOnTop = ui.alwaysOnTop
    const opacity = numberInRange(ui.opacity, "ui.opacity", 0.2, 1)
    if (opacity !== undefined) patch.opacity = opacity
    if (Object.keys(patch).length > 0) output.ui = patch
  }

  if (input.agent !== undefined && typeof input.agent === "object") {
    const ag = input.agent as Record<string, unknown>
    const patch: Partial<AgentSettings> = {}
    const maxSteps = integerInRange(ag.maxSteps, "agent.maxSteps", 1, 100)
    if (maxSteps !== undefined) patch.maxSteps = maxSteps
    if (Object.keys(patch).length > 0) output.agent = patch
  }

  if (input.permissions !== undefined && typeof input.permissions === "object") {
    const permissions = input.permissions as Record<string, unknown>
    const patch: Partial<PermissionSettings> = {}
    if (permissions.mode !== undefined) {
      if (!isPermissionMode(permissions.mode)) throw new Error(`Invalid permission mode: ${String(permissions.mode)}`)
      patch.mode = permissions.mode
    }
    if (Object.keys(patch).length > 0) output.permissions = patch
  }

  if (input.emotion !== undefined && typeof input.emotion === "object") {
    const emotion = input.emotion as Record<string, unknown>
    const patch: EmotionSettingsPatch = {}
    if (emotion.enabled !== undefined && typeof emotion.enabled === "boolean") {
      patch.enabled = emotion.enabled
    }
    if (emotion.injectPrompt !== undefined && typeof emotion.injectPrompt === "boolean") {
      patch.injectPrompt = emotion.injectPrompt
    }
    if (emotion.defaultEmotion !== undefined && isEmotion(emotion.defaultEmotion)) {
      patch.defaultEmotion = emotion.defaultEmotion
    }
    if (emotion.stripTagWhenDisabled !== undefined && typeof emotion.stripTagWhenDisabled === "boolean") {
      patch.stripTagWhenDisabled = emotion.stripTagWhenDisabled
    }
    if (Object.keys(patch).length > 0) output.emotion = patch
  }

  if (input.voice !== undefined && typeof input.voice === "object") {
    const voice = input.voice as Record<string, unknown>
    const patch: VoiceInputSettingsPatch = {}
    if (voice.enabled !== undefined && typeof voice.enabled === "boolean") {
      patch.enabled = voice.enabled
    }
    if (voice.audioInputEnabled !== undefined && typeof voice.audioInputEnabled === "boolean") {
      patch.audioInputEnabled = voice.audioInputEnabled
    }
    if (voice.preferredFormat !== undefined) {
      if (voice.preferredFormat !== "wav" && voice.preferredFormat !== "mp3") {
        throw new Error(`Invalid voice.preferredFormat: must be "wav" or "mp3"`)
      }
      patch.preferredFormat = voice.preferredFormat
    }
    const maxDurationMs = integerInRange(voice.maxDurationMs, "voice.maxDurationMs", 1_000, 5 * 60_000)
    if (maxDurationMs !== undefined) patch.maxDurationMs = maxDurationMs
    if (voice.pushToTalkHotkey !== undefined) {
      if (typeof voice.pushToTalkHotkey !== "string" || voice.pushToTalkHotkey.length === 0) {
        throw new Error("voice.pushToTalkHotkey must be a non-empty string")
      }
      patch.pushToTalkHotkey = voice.pushToTalkHotkey
    }
    if (Object.keys(patch).length > 0) output.voice = patch
  }

  return output
}
