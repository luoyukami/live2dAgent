import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_EMOTION_SETTINGS,
  DEFAULT_PROMPT_PRESET_SETTINGS,
  DEFAULT_VOICE_INPUT_SETTINGS,
  DEFAULT_LOCAL_TTS_SETTINGS,
  DEFAULT_COMPANION_WATCH_SETTINGS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_MCP_SETTINGS,
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
  type PromptPresetSettings,
  type PromptPresetSettingsPatch,
  type PublicSettings,
  type ReasoningEffort,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
  type CompanionWatchSettings,
  type MemorySettings,
  type MemorySettingsPatch,
  type TtsSettingsPatch,
  type LocalTtsSettings,
  type McpSettings,
  type McpSettingsPatch,
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
  width: 360,
  height: 720,
  panelWidth: 460,
  panelHeight: 760,
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxSteps: 20,
  runtimeMode: "ws",
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
    openaiMultimodalModel: process.env.OPENAI_MULTIMODAL_MODEL ?? localDevSettings.openaiMultimodalModel,
    reasoningEffort: readEnvReasoningEffort() ?? localDevSettings.reasoningEffort ?? "low",
    openaiApiKey: process.env.OPENAI_API_KEY ?? localDevSettings.openaiApiKey,
    live2d: { ...DEFAULT_LIVE2D_SETTINGS },
    ui: { ...DEFAULT_UI_SETTINGS },
    agent: { ...DEFAULT_AGENT_SETTINGS },
    permissions: { ...DEFAULT_PERMISSION_SETTINGS, ...(localDevSettings.permissions ?? {}) },
    promptPresets: { ...DEFAULT_PROMPT_PRESET_SETTINGS },
    emotion: { ...DEFAULT_EMOTION_SETTINGS },
    voice: { ...DEFAULT_VOICE_INPUT_SETTINGS },
    companionWatch: { ...DEFAULT_COMPANION_WATCH_SETTINGS },
    memory: { ...DEFAULT_MEMORY_SETTINGS },
    tts: { ...DEFAULT_LOCAL_TTS_SETTINGS },
    mcp: { ...DEFAULT_MCP_SETTINGS, configPath: getDefaultMcpConfigPath(userDataDir), servers: {}, search: { ...DEFAULT_MCP_SETTINGS.search } },
  }
}

function getDefaultMcpConfigPath(userDataDir: string): string {
  return join(userDataDir, "mcp.json")
}

const DEFAULT_MCP_CONFIG_JSON = `${JSON.stringify({
  mcpServers: {},
  _live2dAgent: {
    note: "默认无需配置即可使用内置 web_search / web_fetch；它们通过 Parallel Search MCP keyless 模式工作。可在 mcpServers 中添加自定义 MCP server。",
    builtinTools: ["web_search", "web_fetch"],
  },
}, null, 2)}\n`

/* ------------------------------------------------------------------ */
/*  Local development config                                           */
/* ------------------------------------------------------------------ */

type LocalDevSettings = Partial<Pick<AppSettings, "mode" | "openaiBaseUrl" | "openaiModel" | "openaiMultimodalModel" | "openaiApiKey" | "reasoningEffort">> & {
  permissions?: Partial<PermissionSettings>
}

function isDevEnvironment(): boolean {
  return process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL !== undefined
}

function readEnvAgentMode(): AgentMode | undefined {
  return isAgentMode(process.env.AGENT_MODE) ? process.env.AGENT_MODE : undefined
}

function readEnvReasoningEffort(): ReasoningEffort | undefined {
  return isReasoningEffort(process.env.REASONING_EFFORT) ? process.env.REASONING_EFFORT : undefined
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
  if (parsed.openaiMultimodalModel) settings.openaiMultimodalModel = parsed.openaiMultimodalModel
  if (isReasoningEffort(parsed.reasoningEffort)) settings.reasoningEffort = parsed.reasoningEffort
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
  const parsedUi = pickKnownUiSettings((parsed.ui ?? {}) as Record<string, unknown>)
  // Strip `emotionProfile` from the raw parsed payload BEFORE spreading it
  // into the live2d object. The sanitizer below decides whether a cleaned
  // version of the profile should be added back. Spreading the raw value
  // first would let a malformed profile leak into the merged result.
  const { emotionProfile: _drop, ...safeParsedLive2d } = parsedLive2d
  const sanitizedProfile = sanitizeEmotionProfile(parsedLive2d.emotionProfile)
  return {
    ...defaults,
    ...parsed,
    reasoningEffort: isReasoningEffort(parsed.reasoningEffort) ? parsed.reasoningEffort : defaults.reasoningEffort,
    // Nested objects: merge each level with defaults so missing keys don't drop defaults
    live2d: {
      ...defaults.live2d,
      ...safeParsedLive2d,
      ...(sanitizedProfile !== undefined ? { emotionProfile: sanitizedProfile } : {}),
    },
    ui: {
      ...defaults.ui,
      ...parsedUi,
    },
    agent: { ...defaults.agent, ...((parsed.agent ?? {}) as Partial<AgentSettings>) },
    permissions: { ...defaults.permissions, ...((parsed.permissions ?? {}) as Partial<PermissionSettings>) },
    promptPresets: mergePromptPresetSettings(
      (parsed.promptPresets ?? {}) as Partial<PromptPresetSettings>,
      defaults.promptPresets,
    ),
    emotion: mergeEmotionSettings(
      (parsed.emotion ?? {}) as Partial<EmotionSettings>,
      defaults.emotion,
    ),
    voice: {
      ...defaults.voice,
      ...((parsed.voice ?? {}) as Partial<VoiceInputSettings>),
    },
    companionWatch: mergeCompanionWatchSettings(
      (parsed.companionWatch ?? {}) as Partial<CompanionWatchSettings>,
      defaults.companionWatch,
    ),
    memory: mergeMemorySettings(
      shouldMigrateOldDisabledMemoryDefault(parsed.memory) ? {} : ((parsed.memory ?? {}) as Partial<MemorySettings>),
      defaults.memory,
    ),
    tts: {
      ...defaults.tts,
      ...((parsed.tts ?? {}) as Partial<LocalTtsSettings>),
      voiceDisplayNames: {
        ...defaults.tts.voiceDisplayNames,
        ...(((parsed.tts ?? {}) as Partial<LocalTtsSettings>).voiceDisplayNames ?? {}),
      },
    },
    mcp: mergeMcpSettings((parsed.mcp ?? {}) as Partial<McpSettings>, defaults.mcp),
  }
}

function mergeMemorySettings(parsed: Partial<MemorySettings>, defaults: MemorySettings): MemorySettings {
  return {
    ...defaults,
    ...parsed,
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    userProfileEnabled: typeof parsed.userProfileEnabled === "boolean" ? parsed.userProfileEnabled : defaults.userProfileEnabled,
    nudgeInterval: typeof parsed.nudgeInterval === "number" ? Math.max(0, Math.min(1000, Math.floor(parsed.nudgeInterval))) : defaults.nudgeInterval,
    memoryCharLimit: typeof parsed.memoryCharLimit === "number" ? Math.max(100, Math.min(100_000, Math.floor(parsed.memoryCharLimit))) : defaults.memoryCharLimit,
    userCharLimit: typeof parsed.userCharLimit === "number" ? Math.max(100, Math.min(100_000, Math.floor(parsed.userCharLimit))) : defaults.userCharLimit,
  }
}

function shouldMigrateOldDisabledMemoryDefault(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const memory = value as Record<string, unknown>
  return memory.enabled === false
    && memory.userProfileEnabled === false
    && (memory.nudgeInterval === undefined || memory.nudgeInterval === 10)
    && (memory.memoryCharLimit === undefined || memory.memoryCharLimit === 2200)
    && (memory.userCharLimit === undefined || memory.userCharLimit === 1375)
}

function mergeMcpSettings(parsed: Partial<McpSettings>, defaults: McpSettings): McpSettings {
  return {
    ...defaults,
    ...parsed,
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    configPath: typeof parsed.configPath === "string" ? parsed.configPath : defaults.configPath,
    defaultTimeoutMs: typeof parsed.defaultTimeoutMs === "number" ? parsed.defaultTimeoutMs : defaults.defaultTimeoutMs,
    servers: isPlainObject(parsed.servers) ? (parsed.servers as McpSettings["servers"]) : defaults.servers,
    search: {
      ...defaults.search,
      ...(isPlainObject(parsed.search) ? parsed.search : {}),
      enabled: typeof parsed.search?.enabled === "boolean" ? parsed.search.enabled : defaults.search.enabled,
      provider: parsed.search?.provider === "parallel" || parsed.search?.provider === "brave" ? parsed.search.provider : defaults.search.provider,
      autoRegisterServer: typeof parsed.search?.autoRegisterServer === "boolean" ? parsed.search.autoRegisterServer : defaults.search.autoRegisterServer,
      parallelApiKey: typeof parsed.search?.parallelApiKey === "string" ? parsed.search.parallelApiKey : defaults.search.parallelApiKey,
      braveApiKey: typeof parsed.search?.braveApiKey === "string" ? parsed.search.braveApiKey : defaults.search.braveApiKey,
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function mergeCompanionWatchSettings(
  parsed: Partial<CompanionWatchSettings>,
  defaults: CompanionWatchSettings,
): CompanionWatchSettings {
  return {
    attachScreenshotOnUserMessage: pickBoolean(parsed.attachScreenshotOnUserMessage, defaults.attachScreenshotOnUserMessage),
    proactiveEnabled: pickBoolean(parsed.proactiveEnabled, defaults.proactiveEnabled),
    proactiveInterval: isCompanionWatchInterval(parsed.proactiveInterval)
      ? parsed.proactiveInterval
      : defaults.proactiveInterval,
  }
}

function pickKnownUiSettings(raw: Record<string, unknown>): Partial<UiSettings> {
  const picked: Partial<UiSettings> = {}
  if (typeof raw.alwaysOnTop === "boolean") picked.alwaysOnTop = raw.alwaysOnTop
  if (typeof raw.opacity === "number") picked.opacity = raw.opacity
  if (typeof raw.width === "number") picked.width = raw.width
  if (typeof raw.height === "number") picked.height = raw.height
  if (typeof raw.panelWidth === "number") picked.panelWidth = raw.panelWidth
  if (typeof raw.panelHeight === "number") picked.panelHeight = raw.panelHeight
  return picked
}

function mergePromptPresetSettings(
  parsed: Partial<PromptPresetSettings>,
  defaults: PromptPresetSettings,
): PromptPresetSettings {
  return {
    rolePrompt: pickString(parsed.rolePrompt, defaults.rolePrompt),
    userInfoPrompt: pickString(parsed.userInfoPrompt, defaults.userInfoPrompt),
  }
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
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

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return v === "none" || v === "low" || v === "medium" || v === "high"
}

function isCompanionWatchInterval(v: unknown): v is CompanionWatchSettings["proactiveInterval"] {
  return v === "30s" || v === "1m" || v === "2m" || v === "random"
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

    this.disableProactiveCompanionWatchOnStartup()
    this.applyLocalDevModelFallback()
    this.ensureDefaultMcpConfig()
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
    this.ensureDefaultMcpConfig()
    return this.getPublicSettings()
  }

  /** Full settings (internal use only — never expose apiKey to renderer) */
  get(): AppSettings {
    return { ...this._settings }
  }

  getMemoryDir(): string {
    return join(this.userDataDir, "memories")
  }

  private ensureDefaultMcpConfig(): void {
    const defaultConfigPath = getDefaultMcpConfigPath(this.userDataDir)
    let changed = false

    if (!this._settings.mcp.configPath.trim()) {
      this._settings = {
        ...this._settings,
        mcp: { ...this._settings.mcp, configPath: defaultConfigPath },
      }
      changed = true
    }

    const configPath = this._settings.mcp.configPath.trim()
    if (configPath === defaultConfigPath && !existsSync(configPath)) {
      writeFileSync(configPath, DEFAULT_MCP_CONFIG_JSON, "utf8")
    }

    const hasConfiguredServer = Object.keys(this._settings.mcp.servers).length > 0
    const shouldEnableBuiltinSearch = this._settings.mcp.enabled
      && !hasConfiguredServer
      && configPath === defaultConfigPath
      && (!this._settings.mcp.search.enabled || this._settings.mcp.search.provider !== "parallel")

    if (shouldEnableBuiltinSearch) {
      this._settings = {
        ...this._settings,
        mcp: {
          ...this._settings.mcp,
          search: {
            ...this._settings.mcp.search,
            enabled: true,
            provider: "parallel",
            autoRegisterServer: true,
          },
        },
      }
      changed = true
    }

    if (changed) this.persist()
  }

  /** Public-safe settings — apiKey replaced with hasApiKey boolean */
  getPublicSettings(): PublicSettings {
    const { openaiApiKey: _key, ...rest } = this._settings
    const publicSettings = { ...rest, hasApiKey: Boolean(this._settings.openaiApiKey) }
    if (publicSettings.mcp?.search?.braveApiKey || publicSettings.mcp?.search?.parallelApiKey) {
      publicSettings.mcp = {
        ...publicSettings.mcp,
        search: { ...publicSettings.mcp.search, braveApiKey: undefined, parallelApiKey: undefined },
      }
    }
    return publicSettings
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
    if (validated.openaiMultimodalModel !== undefined) this._settings.openaiMultimodalModel = validated.openaiMultimodalModel || undefined
    if (validated.reasoningEffort !== undefined) this._settings.reasoningEffort = validated.reasoningEffort
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
    if (validated.promptPresets !== undefined) {
      this._settings.promptPresets = { ...this._settings.promptPresets, ...validated.promptPresets }
    }
    if (validated.emotion !== undefined) {
      this._settings.emotion = applyEmotionPatch(this._settings.emotion, validated.emotion)
    }
    if (validated.voice !== undefined) {
      this._settings.voice = { ...this._settings.voice, ...validated.voice }
    }
    if (validated.companionWatch !== undefined) {
      this._settings.companionWatch = { ...this._settings.companionWatch, ...validated.companionWatch }
    }
    if (validated.memory !== undefined) {
      this._settings.memory = { ...this._settings.memory, ...validated.memory }
    }
    if (validated.tts !== undefined) {
      this._settings.tts = { ...this._settings.tts, ...validated.tts }
    }
    if (validated.mcp !== undefined) {
      this._settings.mcp = mergeMcpSettings(validated.mcp as Partial<McpSettings>, this._settings.mcp)
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

  private disableProactiveCompanionWatchOnStartup(): void {
    if (!this._settings.companionWatch.proactiveEnabled) return
    this._settings.companionWatch.proactiveEnabled = false
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

  if (input.openaiMultimodalModel !== undefined) {
    if (typeof input.openaiMultimodalModel !== "string") {
      throw new Error("openaiMultimodalModel must be a string")
    }
    output.openaiMultimodalModel = input.openaiMultimodalModel.trim()
  }

  if (input.reasoningEffort !== undefined) {
    if (!isReasoningEffort(input.reasoningEffort)) {
      throw new Error(`Invalid reasoning effort: ${String(input.reasoningEffort)}`)
    }
    output.reasoningEffort = input.reasoningEffort
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
    const width = integerInRange(ui.width, "ui.width", 200, 4000)
    const height = integerInRange(ui.height, "ui.height", 200, 4000)
    const panelWidth = integerInRange(ui.panelWidth, "ui.panelWidth", 200, 4000)
    const panelHeight = integerInRange(ui.panelHeight, "ui.panelHeight", 200, 4000)
    if (opacity !== undefined) patch.opacity = opacity
    if (width !== undefined) patch.width = width
    if (height !== undefined) patch.height = height
    if (panelWidth !== undefined) patch.panelWidth = panelWidth
    if (panelHeight !== undefined) patch.panelHeight = panelHeight
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

  if (input.promptPresets !== undefined && typeof input.promptPresets === "object") {
    const promptPresets = input.promptPresets as Record<string, unknown>
    const patch: PromptPresetSettingsPatch = {}
    if (promptPresets.rolePrompt !== undefined) {
      if (typeof promptPresets.rolePrompt !== "string") throw new Error("promptPresets.rolePrompt must be a string")
      patch.rolePrompt = promptPresets.rolePrompt
    }
    if (promptPresets.userInfoPrompt !== undefined) {
      if (typeof promptPresets.userInfoPrompt !== "string") throw new Error("promptPresets.userInfoPrompt must be a string")
      patch.userInfoPrompt = promptPresets.userInfoPrompt
    }
    if (Object.keys(patch).length > 0) output.promptPresets = patch
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

  if (input.companionWatch !== undefined && typeof input.companionWatch === "object") {
    const companionWatch = input.companionWatch as Record<string, unknown>
    const patch: Partial<CompanionWatchSettings> = {}
    if (companionWatch.attachScreenshotOnUserMessage !== undefined) {
      if (typeof companionWatch.attachScreenshotOnUserMessage !== "boolean") {
        throw new Error("companionWatch.attachScreenshotOnUserMessage must be a boolean")
      }
      patch.attachScreenshotOnUserMessage = companionWatch.attachScreenshotOnUserMessage
    }
    if (companionWatch.proactiveEnabled !== undefined) {
      if (typeof companionWatch.proactiveEnabled !== "boolean") {
        throw new Error("companionWatch.proactiveEnabled must be a boolean")
      }
      patch.proactiveEnabled = companionWatch.proactiveEnabled
    }
    if (companionWatch.proactiveInterval !== undefined) {
      if (!isCompanionWatchInterval(companionWatch.proactiveInterval)) {
        throw new Error(`Invalid companionWatch.proactiveInterval: must be "30s", "1m", "2m", or "random"`)
      }
      patch.proactiveInterval = companionWatch.proactiveInterval
    }
    if (Object.keys(patch).length > 0) output.companionWatch = patch
  }

  if (input.memory !== undefined && typeof input.memory === "object") {
    const memory = input.memory as Record<string, unknown>
    const patch: MemorySettingsPatch = {}
    if (memory.enabled !== undefined) {
      if (typeof memory.enabled !== "boolean") throw new Error("memory.enabled must be a boolean")
      patch.enabled = memory.enabled
    }
    if (memory.userProfileEnabled !== undefined) {
      if (typeof memory.userProfileEnabled !== "boolean") throw new Error("memory.userProfileEnabled must be a boolean")
      patch.userProfileEnabled = memory.userProfileEnabled
    }
    const nudgeInterval = integerInRange(memory.nudgeInterval, "memory.nudgeInterval", 0, 1000)
    if (nudgeInterval !== undefined) patch.nudgeInterval = nudgeInterval
    const memoryCharLimit = integerInRange(memory.memoryCharLimit, "memory.memoryCharLimit", 100, 100_000)
    if (memoryCharLimit !== undefined) patch.memoryCharLimit = memoryCharLimit
    const userCharLimit = integerInRange(memory.userCharLimit, "memory.userCharLimit", 100, 100_000)
    if (userCharLimit !== undefined) patch.userCharLimit = userCharLimit
    if (Object.keys(patch).length > 0) output.memory = patch
  }

  if (input.tts !== undefined && typeof input.tts === "object") {
    const tts = input.tts as Record<string, unknown>
    const patch: TtsSettingsPatch = {}
    if (tts.enabled !== undefined && typeof tts.enabled === "boolean") {
      patch.enabled = tts.enabled
    }
    if (tts.apiBaseUrl !== undefined && typeof tts.apiBaseUrl === "string") {
      patch.apiBaseUrl = tts.apiBaseUrl
    }
    if (tts.selectedVoiceId !== undefined && typeof tts.selectedVoiceId === "string") {
      patch.selectedVoiceId = tts.selectedVoiceId
    }
    if (tts.voiceDisplayNames !== undefined && typeof tts.voiceDisplayNames === "object") {
      patch.voiceDisplayNames = tts.voiceDisplayNames as Record<string, string>
    }
    if (tts.ttsMode !== undefined) {
      if (tts.ttsMode !== "standard" && tts.ttsMode !== "emotion_enhanced") {
        throw new Error(`Invalid tts.ttsMode: must be "standard" or "emotion_enhanced"`)
      }
      patch.ttsMode = tts.ttsMode
    }
    if (tts.emotionControlMode !== undefined) {
      if (tts.emotionControlMode !== "default_mapping" && tts.emotionControlMode !== "llm_controlled") {
        throw new Error(`Invalid tts.emotionControlMode: must be "default_mapping" or "llm_controlled"`)
      }
      patch.emotionControlMode = tts.emotionControlMode
    }
    const speed = numberInRange(tts.speed, "tts.speed", 0.5, 2.0)
    if (speed !== undefined) patch.speed = speed
    const seed = integerInRange(tts.seed, "tts.seed", -1, 99999)
    if (seed !== undefined) patch.seed = seed
    if (tts.audioOutputDir !== undefined && typeof tts.audioOutputDir === "string") {
      patch.audioOutputDir = tts.audioOutputDir
    }
    if (tts.autoGenerateOnAssistantMessage !== undefined && typeof tts.autoGenerateOnAssistantMessage === "boolean") {
      patch.autoGenerateOnAssistantMessage = tts.autoGenerateOnAssistantMessage
    }
    if (tts.autoPlayAfterGenerate !== undefined && typeof tts.autoPlayAfterGenerate === "boolean") {
      patch.autoPlayAfterGenerate = tts.autoPlayAfterGenerate
    }
    const requestTimeoutMs = integerInRange(tts.requestTimeoutMs, "tts.requestTimeoutMs", 1000, 600_000)
    if (requestTimeoutMs !== undefined) patch.requestTimeoutMs = requestTimeoutMs
    if (Object.keys(patch).length > 0) output.tts = patch
  }

  if (input.mcp !== undefined && typeof input.mcp === "object") {
    const mcp = input.mcp as Record<string, unknown>
    const patch: McpSettingsPatch = {}
    if (mcp.enabled !== undefined) {
      if (typeof mcp.enabled !== "boolean") throw new Error("mcp.enabled must be a boolean")
      patch.enabled = mcp.enabled
    }
    if (mcp.configPath !== undefined) {
      if (typeof mcp.configPath !== "string") throw new Error("mcp.configPath must be a string")
      patch.configPath = mcp.configPath.trim()
    }
    const defaultTimeoutMs = integerInRange(mcp.defaultTimeoutMs, "mcp.defaultTimeoutMs", 1_000, 600_000)
    if (defaultTimeoutMs !== undefined) patch.defaultTimeoutMs = defaultTimeoutMs
    if (mcp.servers !== undefined) {
      if (!isPlainObject(mcp.servers)) throw new Error("mcp.servers must be an object")
      patch.servers = sanitizeMcpServers(mcp.servers)
    }
    if (mcp.search !== undefined) {
      if (!isPlainObject(mcp.search)) throw new Error("mcp.search must be an object")
      const search = mcp.search as Record<string, unknown>
      const searchPatch: Partial<import("@live2d-agent/shared").McpSearchSettings> = {}
      if (search.enabled !== undefined) {
        if (typeof search.enabled !== "boolean") throw new Error("mcp.search.enabled must be a boolean")
        searchPatch.enabled = search.enabled
      }
      if (search.provider !== undefined) {
        if (search.provider !== "parallel" && search.provider !== "brave") throw new Error("mcp.search.provider must be parallel or brave")
        searchPatch.provider = search.provider
      }
      if (search.parallelApiKey !== undefined) {
        if (typeof search.parallelApiKey !== "string") throw new Error("mcp.search.parallelApiKey must be a string")
        searchPatch.parallelApiKey = search.parallelApiKey
      }
      if (search.braveApiKey !== undefined) {
        if (typeof search.braveApiKey !== "string") throw new Error("mcp.search.braveApiKey must be a string")
        searchPatch.braveApiKey = search.braveApiKey
      }
      if (search.autoRegisterServer !== undefined) {
        if (typeof search.autoRegisterServer !== "boolean") throw new Error("mcp.search.autoRegisterServer must be a boolean")
        searchPatch.autoRegisterServer = search.autoRegisterServer
      }
      if (Object.keys(searchPatch).length > 0) patch.search = searchPatch
    }
    if (Object.keys(patch).length > 0) output.mcp = patch
  }

  return output
}

function sanitizeMcpServers(value: Record<string, unknown>): import("@live2d-agent/shared").McpSettings["servers"] {
  const servers: import("@live2d-agent/shared").McpSettings["servers"] = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !isPlainObject(raw)) continue
    const input = raw as Record<string, unknown>
    const server: import("@live2d-agent/shared").McpServerSettings = {}
    if (typeof input.enabled === "boolean") server.enabled = input.enabled
    if (input.type === "stdio" || input.type === "sse" || input.type === "streamable_http" || input.type === "http") server.type = input.type
    if (typeof input.command === "string") server.command = input.command
    if (Array.isArray(input.args)) server.args = input.args.filter((item): item is string => typeof item === "string")
    if (isPlainObject(input.env)) server.env = stringRecord(input.env)
    if (typeof input.cwd === "string") server.cwd = input.cwd
    if (typeof input.url === "string") server.url = input.url
    if (isPlainObject(input.headers)) server.headers = stringRecord(input.headers)
    if (typeof input.bearerToken === "string") server.bearerToken = input.bearerToken
    if (typeof input.timeoutMs === "number") server.timeoutMs = input.timeoutMs
    if (typeof input.trust === "boolean") server.trust = input.trust
    servers[name] = server
  }
  return servers
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") out[key] = child
  }
  return out
}
