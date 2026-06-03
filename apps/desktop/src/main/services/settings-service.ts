import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentMode } from "@live2d-agent/shared"

export interface AppSettings {
  mode: AgentMode
  workspaceDir: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey?: string
}

export class SettingsService {
  private settings: AppSettings
  private readonly file: string

  constructor(private readonly userDataDir: string) {
    this.file = join(userDataDir, "settings.json")
    mkdirSync(userDataDir, { recursive: true })
    const workspaceDir = join(userDataDir, "workspace")
    mkdirSync(workspaceDir, { recursive: true })

    this.settings = {
      mode: "confirm",
      workspaceDir,
      openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      openaiApiKey: process.env.OPENAI_API_KEY,
    }

    if (existsSync(this.file)) {
      this.settings = { ...this.settings, ...JSON.parse(readFileSync(this.file, "utf8")) }
    } else {
      this.persist()
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  getPublicSettings(): Omit<AppSettings, "openaiApiKey"> & { hasApiKey: boolean } {
    const { openaiApiKey: _key, ...publicSettings } = this.settings
    return { ...publicSettings, hasApiKey: Boolean(this.settings.openaiApiKey) }
  }

  update(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch }
    if (patch.workspaceDir) mkdirSync(patch.workspaceDir, { recursive: true })
    this.persist()
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8")
  }
}
