import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, TraceStore } from "@live2d-agent/agent-core"

export class TraceService implements TraceStore {
  private readonly traceFile: string

  constructor(userDataDir: string) {
    const tracesDir = join(userDataDir, "traces")
    mkdirSync(tracesDir, { recursive: true })
    this.traceFile = join(tracesDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  }

  append(event: AgentEvent): void {
    appendFileSync(this.traceFile, `${JSON.stringify({ ts: Date.now(), event })}\n`, "utf8")
  }
}
