import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, TraceStore } from "@live2d-agent/agent-core"

export interface TraceEntry {
  ts: number
  event: AgentEvent
}

/**
 * Writes trace events to:
 *   userData/traces/sessions/<timestamp>.jsonl  — one per session
 *   userData/traces/latest.jsonl                — overwritten each session
 *
 * Before writing, events are sanitised to strip large binary / base64 payloads
 * so that trace files stay small and readable.
 */
export class TraceService implements TraceStore {
  private readonly sessionFile: string
  private readonly latestFile: string
  private readonly tracesDir: string
  private readonly events: TraceEntry[] = []

  constructor(userDataDir: string) {
    this.tracesDir = join(userDataDir, "traces")
    const sessionsDir = join(this.tracesDir, "sessions")
    mkdirSync(sessionsDir, { recursive: true })
    this.sessionFile = join(sessionsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    this.latestFile = join(userDataDir, "traces", "latest.jsonl")
    // Initialise latest.jsonl (truncate any previous session data)
    writeFileSync(this.latestFile, "", "utf8")
  }

  append(event: AgentEvent): void {
    const sanitised = this.sanitiseEvent(event)
    const entry = { ts: Date.now(), event: sanitised }
    this.events.push(entry)
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500)
    const line = `${JSON.stringify(entry)}\n`
    appendFileSync(this.sessionFile, line, "utf8")
    appendFileSync(this.latestFile, line, "utf8")
  }

  getSessionFile(): string {
    return this.sessionFile
  }

  getTracesDir(): string {
    return this.tracesDir
  }

  getRecentEvents(limit = 100): TraceEntry[] {
    return this.events.slice(-limit)
  }

  readCurrentEvents(): TraceEntry[] {
    if (this.events.length > 0) return [...this.events]
    if (!existsSync(this.latestFile)) return []
    return readFileSync(this.latestFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TraceEntry]
        } catch {
          return []
        }
      })
  }

  /* ---------------------------------------------------------------- */
  /*  Sanitizer — strip large / sensitive binary payloads              */
  /* ---------------------------------------------------------------- */

  /**
   * Recursively walk the event and replace any value that:
   *  - is a key named `imageBase64` → `[omitted base64 data]`
   *  - is a string longer than 500 chars composed entirely of base64
   *    characters (a-z, A-Z, 0-9, +, /, =)
   *  - is a data URL (starts with "data:") longer than 500 chars → `[omitted data url]`
   */
  private sanitiseEvent(event: AgentEvent): AgentEvent {
    return JSON.parse(this.sanitiseValue(JSON.stringify(event)))
  }

  private sanitiseValue(json: string): string {
    // Match quoted string values that need sanitising
    return json.replace(
      /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
      (match, key: string, value: string) => {
        // Sanitise based on key name
        if (key === "imageBase64") {
          return `"${key}":"[omitted base64 data]"`
        }

        // Sanitise long data URLs
        if (value.startsWith("data:") && value.length > 500) {
          return `"${key}":"[omitted data url]"`
        }

        // Sanitise long plain base64 strings
        if (value.length > 500 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
          return `"${key}":"[omitted base64 data]"`
        }

        return match
      },
    )
  }
}
