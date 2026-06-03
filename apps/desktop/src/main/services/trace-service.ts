import { mkdirSync, appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, TraceStore } from "@live2d-agent/agent-core"

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

  constructor(userDataDir: string) {
    const sessionsDir = join(userDataDir, "traces", "sessions")
    mkdirSync(sessionsDir, { recursive: true })
    this.sessionFile = join(sessionsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    this.latestFile = join(userDataDir, "traces", "latest.jsonl")
    // Initialise latest.jsonl (truncate any previous session data)
    writeFileSync(this.latestFile, "", "utf8")
  }

  append(event: AgentEvent): void {
    const sanitised = this.sanitiseEvent(event)
    const line = `${JSON.stringify({ ts: Date.now(), event: sanitised })}\n`
    appendFileSync(this.sessionFile, line, "utf8")
    appendFileSync(this.latestFile, line, "utf8")
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
