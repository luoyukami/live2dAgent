import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  AgentMode,
  AppSettings,
  AppSettingsPublicPatch,
  Live2DSettings,
  Live2DSettingsPatch,
  UiSettings,
  AgentSettings,
  PublicSettings,
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

export function createDefaultSettings(userDataDir: string): AppSettings {
  const workspaceDir = join(userDataDir, "workspace")
  mkdirSync(workspaceDir, { recursive: true })

  return {
    mode: "confirm",
    workspaceDir,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    openaiApiKey: process.env.OPENAI_API_KEY,
    live2d: { ...DEFAULT_LIVE2D_SETTINGS },
    ui: { ...DEFAULT_UI_SETTINGS },
    agent: { ...DEFAULT_AGENT_SETTINGS },
  }
}

/* ------------------------------------------------------------------ */
/*  Deep-merge helpers                                                */
/* ------------------------------------------------------------------ */

function deepMergeDefaults(parsed: Record<string, unknown>, defaults: AppSettings): AppSettings {
  return {
    ...defaults,
    ...parsed,
    // Nested objects: merge each level with defaults so missing keys don't drop defaults
    live2d: { ...defaults.live2d, ...((parsed.live2d ?? {}) as Partial<Live2DSettings>) },
    ui: { ...defaults.ui, ...((parsed.ui ?? {}) as Partial<UiSettings>) },
    agent: { ...defaults.agent, ...((parsed.agent ?? {}) as Partial<AgentSettings>) },
  }
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
  const candidates: string[] = []

  /* 1. process.cwd() — reliable during `pnpm dev` from repo root */
  candidates.push(process.cwd())

  /* 2. Derive from the bundle location (out/main/main.js -> repo root) */
  try {
    const modulePath = fileURLToPath(import.meta.url)
    candidates.push(resolve(dirname(modulePath), "..", "..", ".."))
  } catch {
    /* ignore – import.meta.url may not be available */
  }

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

    /* ---- Dev fallback: use local model when modelPath is empty ---- */
    if (!this._settings.live2d.modelPath) {
      const localModel = findLocalDevModelPath()
      if (localModel) {
        this._settings.live2d.modelPath = localModel
        this.persist()
      }
    }
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
      this._settings.live2d = { ...this._settings.live2d, ...validated.live2d }
    }
    if (validated.ui !== undefined) {
      this._settings.ui = { ...this._settings.ui, ...validated.ui }
    }
    if (validated.agent !== undefined) {
      this._settings.agent = { ...this._settings.agent, ...validated.agent }
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

  return output
}
