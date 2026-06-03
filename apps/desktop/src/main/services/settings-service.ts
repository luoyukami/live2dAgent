import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
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
  return typeof v === "number" && !Number.isNaN(v)
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
    this._settings.live2d.modelPath = modelPath
    this.persist()
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
    if (l2d.scale !== undefined && isNumber(l2d.scale)) patch.scale = l2d.scale
    if (l2d.x !== undefined && isNumber(l2d.x)) patch.x = l2d.x
    if (l2d.y !== undefined && isNumber(l2d.y)) patch.y = l2d.y
    // modelPath is NOT allowed through public patch (sensitive local path)
    if (Object.keys(patch).length > 0) output.live2d = patch
  }

  if (input.ui !== undefined && typeof input.ui === "object") {
    const ui = input.ui as Record<string, unknown>
    const patch: Partial<UiSettings> = {}
    if (ui.alwaysOnTop !== undefined && typeof ui.alwaysOnTop === "boolean") patch.alwaysOnTop = ui.alwaysOnTop
    if (ui.opacity !== undefined && isNumber(ui.opacity)) patch.opacity = ui.opacity
    if (Object.keys(patch).length > 0) output.ui = patch
  }

  if (input.agent !== undefined && typeof input.agent === "object") {
    const ag = input.agent as Record<string, unknown>
    const patch: Partial<AgentSettings> = {}
    if (ag.maxSteps !== undefined && isNumber(ag.maxSteps)) patch.maxSteps = ag.maxSteps
    if (Object.keys(patch).length > 0) output.agent = patch
  }

  return output
}
