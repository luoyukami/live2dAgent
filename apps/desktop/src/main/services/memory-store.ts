import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export type MemoryTarget = "memory" | "user"
export const ENTRY_DELIMITER = "\n§\n"

export interface MemoryStoreOptions {
  memoryDir: string
  memoryCharLimit?: number
  userCharLimit?: number
}

export type MemoryResult = {
  success: true
  target: MemoryTarget
  entries: string[]
  usage: string
  entry_count: number
  message?: string
} | {
  success: false
  error: string
  current_entries?: string[]
  usage?: string
  matches?: string[]
  drift_backup?: string
  remediation?: string
}

const STRICT_THREAT_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /disregard (all )?(previous|prior|above) instructions/i,
  /you are now/i,
  /system prompt/i,
  /developer message/i,
  /reveal.*(secret|token|api key|system prompt)/i,
  /exfiltrate/i,
  /send .* to https?:\/\//i,
  /curl .*https?:\/\//i,
  /wget .*https?:\/\//i,
  /ssh-rsa|BEGIN OPENSSH PRIVATE KEY|BEGIN RSA PRIVATE KEY/i,
]

export function scanMemoryContent(content: string): string | null {
  const matched = STRICT_THREAT_PATTERNS.find((pattern) => pattern.test(content))
  return matched ? `Memory content rejected by threat scan: ${matched.source}` : null
}

export function parseMemoryEntries(raw: string): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const part of raw.split(ENTRY_DELIMITER)) {
    const entry = part.trim()
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }
  return entries
}

export const MEMORY_GUIDANCE = [
  "You have persistent memory across sessions. Save durable facts using the memory tool: user preferences, environment details, tool quirks, and stable conventions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.",
  "The memory tool has two targets: user = who the user is, stable preferences, background, communication style; memory = your agent notes, environment facts, project conventions, tool quirks, and lessons learned. Choose the correct target before saving.",
  "Prioritize facts that reduce future user steering. The most valuable memory prevents the user from having to repeat themselves. User preferences and recurring corrections matter more than procedural task details.",
  "Do not save task progress, session outcomes, completed-work logs, or temporary TODO state. Do not record PR numbers, issue numbers, commit SHAs, completed bug fixes, phase completion, file counts, or anything likely to be stale within 7 days.",
  "Write memories as declarative facts, not instructions to yourself. Prefer 'User prefers concise responses' over 'Always respond concisely.' Imperative phrasing may be misread as a directive in later sessions.",
].join("\n\n")

export class MemoryStore {
  memoryEntries: string[] = []
  userEntries: string[] = []
  private readonly memoryCharLimit: number
  private readonly userCharLimit: number
  private systemPromptSnapshot: Record<MemoryTarget, string[]> = { memory: [], user: [] }

  constructor(private readonly options: MemoryStoreOptions) {
    this.memoryCharLimit = options.memoryCharLimit ?? 2200
    this.userCharLimit = options.userCharLimit ?? 1375
  }

  loadFromDisk(): void {
    mkdirSync(this.options.memoryDir, { recursive: true })
    this.memoryEntries = this.loadTarget("memory").entries
    this.userEntries = this.loadTarget("user").entries
    this.systemPromptSnapshot = {
      memory: this.memoryEntries.map((entry) => scanMemoryContent(entry) ? blockedPlaceholder("MEMORY.md") : entry),
      user: this.userEntries.map((entry) => scanMemoryContent(entry) ? blockedPlaceholder("USER.md") : entry),
    }
  }

  formatForSystemPrompt(target: MemoryTarget): string | null {
    const entries = this.systemPromptSnapshot[target]
    if (entries.length === 0) return null
    const limit = this.charLimit(target)
    const current = entries.join(ENTRY_DELIMITER).length
    const pct = Math.round((current / limit) * 100)
    const title = target === "memory" ? "MEMORY (your personal notes)" : "USER PROFILE (who the user is)"
    return [
      "══════════════════════════════════════════════",
      `${title} [${pct}% — ${current}/${limit} chars]`,
      "══════════════════════════════════════════════",
      entries.join(ENTRY_DELIMITER),
    ].join("\n")
  }

  add(target: MemoryTarget, content: string): MemoryResult {
    const normalized = content.trim()
    if (!normalized) return { success: false, error: "Content cannot be empty." }
    const threat = scanMemoryContent(normalized)
    if (threat) return { success: false, error: threat }
    return this.withTargetLock(target, () => {
      const drift = this.reloadTargetAndDetectDrift(target)
      if (drift) return drift
      const entries = this.entriesFor(target)
      if (entries.includes(normalized)) return this.success(target, "Entry already exists (no duplicate added).")
      const next = [...entries, normalized]
      const capacity = this.checkCapacity(target, next)
      if (capacity) return capacity
      this.setEntries(target, next)
      this.saveTarget(target)
      return this.success(target, "Entry added.")
    })
  }

  replace(target: MemoryTarget, oldText: string, newContent: string): MemoryResult {
    const oldNeedle = oldText.trim()
    const normalized = newContent.trim()
    if (!oldNeedle) return { success: false, error: "old_text cannot be empty." }
    if (!normalized) return { success: false, error: "content cannot be empty. Use remove to delete entries." }
    const threat = scanMemoryContent(normalized)
    if (threat) return { success: false, error: threat }
    return this.withTargetLock(target, () => {
      const drift = this.reloadTargetAndDetectDrift(target)
      if (drift) return drift
      const match = findUniqueMatch(this.entriesFor(target), oldNeedle)
      if (!match.ok) return match.error
      const next = [...this.entriesFor(target)]
      next[match.index] = normalized
      const capacity = this.checkCapacity(target, next)
      if (capacity) return capacity
      this.setEntries(target, next)
      this.saveTarget(target)
      return this.success(target, "Entry replaced.")
    })
  }

  remove(target: MemoryTarget, oldText: string): MemoryResult {
    const oldNeedle = oldText.trim()
    if (!oldNeedle) return { success: false, error: "old_text cannot be empty." }
    return this.withTargetLock(target, () => {
      const drift = this.reloadTargetAndDetectDrift(target)
      if (drift) return drift
      const match = findUniqueMatch(this.entriesFor(target), oldNeedle)
      if (!match.ok) return match.error
      const next = [...this.entriesFor(target)]
      next.splice(match.index, 1)
      this.setEntries(target, next)
      this.saveTarget(target)
      return this.success(target, "Entry removed.")
    })
  }

  private pathFor(target: MemoryTarget): string {
    return join(this.options.memoryDir, target === "user" ? "USER.md" : "MEMORY.md")
  }

  private entriesFor(target: MemoryTarget): string[] {
    return target === "memory" ? this.memoryEntries : this.userEntries
  }

  private setEntries(target: MemoryTarget, entries: string[]): void {
    if (target === "memory") this.memoryEntries = entries
    else this.userEntries = entries
  }

  private charLimit(target: MemoryTarget): number {
    return target === "memory" ? this.memoryCharLimit : this.userCharLimit
  }

  private loadTarget(target: MemoryTarget): { entries: string[]; drift?: MemoryResult } {
    const file = this.pathFor(target)
    if (!existsSync(file)) return { entries: [] }
    const raw = readFileSync(file, "utf8")
    const entries = parseMemoryEntries(raw)
    const roundtrip = entries.join(ENTRY_DELIMITER)
    const limit = this.charLimit(target)
    const drifted = raw.trim() !== roundtrip || entries.some((entry) => entry.length > limit)
    if (drifted) return { entries, drift: this.createDriftBackup(target, raw) }
    return { entries }
  }

  private reloadTargetAndDetectDrift(target: MemoryTarget): MemoryResult | null {
    const loaded = this.loadTarget(target)
    this.setEntries(target, loaded.entries)
    return loaded.drift ?? null
  }

  private createDriftBackup(target: MemoryTarget, raw: string): MemoryResult {
    const file = this.pathFor(target)
    const backup = `${file}.bak.${Date.now()}`
    writeFileSync(backup, raw, "utf8")
    return {
      success: false,
      error: `Refusing to write ${basename(file)}: file on disk has content that would not round-trip through the memory tool. A snapshot was saved to ${basename(backup)}. Resolve the drift first.`,
      drift_backup: backup,
      remediation: "Open the .bak file, integrate missing entries one at a time via memory(action=add, ...), then rewrite the original file to a clean §-delimited state.",
    }
  }

  private checkCapacity(target: MemoryTarget, entries: string[]): MemoryResult | null {
    const limit = this.charLimit(target)
    const total = entries.join(ENTRY_DELIMITER).length
    if (total <= limit) return null
    return {
      success: false,
      error: `Memory would exceed ${limit} chars (${total}/${limit}). Consolidate overlapping entries or remove stale entries, then retry.`,
      current_entries: this.entriesFor(target),
      usage: this.usage(target, this.entriesFor(target)),
    }
  }

  private saveTarget(target: MemoryTarget): void {
    atomicWriteFileSync(this.pathFor(target), this.entriesFor(target).join(ENTRY_DELIMITER))
  }

  private success(target: MemoryTarget, message: string): MemoryResult {
    const entries = this.entriesFor(target)
    return { success: true, target, entries, usage: this.usage(target, entries), entry_count: entries.length, message }
  }

  private usage(target: MemoryTarget, entries: string[]): string {
    const limit = this.charLimit(target)
    const current = entries.join(ENTRY_DELIMITER).length
    const pct = Math.round((current / limit) * 100)
    return `${pct}% — ${current}/${limit} chars`
  }

  private withTargetLock<T>(target: MemoryTarget, fn: () => T): T {
    mkdirSync(this.options.memoryDir, { recursive: true })
    const lockPath = `${this.pathFor(target)}.lock`
    const started = Date.now()
    while (true) {
      try {
        const fd = openSync(lockPath, "wx")
        closeSync(fd)
        break
      } catch {
        if (existsSync(lockPath) && Date.now() - started > 3000) rmSync(lockPath, { force: true })
        if (Date.now() - started > 5000) throw new Error(`Timed out acquiring memory lock for ${target}`)
      }
    }
    try {
      return fn()
    } finally {
      rmSync(lockPath, { force: true })
    }
  }
}

function findUniqueMatch(entries: string[], oldText: string): { ok: true; index: number } | { ok: false; error: MemoryResult } {
  const matches = entries.map((entry, index) => ({ entry, index })).filter((item) => item.entry.includes(oldText))
  if (matches.length === 0) return { ok: false, error: { success: false, error: `No entry matched '${oldText}'.` } }
  if (new Set(matches.map((item) => item.entry)).size > 1) {
    return { ok: false, error: { success: false, error: `Multiple entries matched '${oldText}'. Be more specific.`, matches: matches.map((item) => preview(item.entry)) } }
  }
  return { ok: true, index: matches[0]!.index }
}

function preview(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function blockedPlaceholder(fileName: string): string {
  return `[BLOCKED: ${fileName} entry contained threat pattern(s). Removed from system prompt; inspect and delete the original using memory tools.]`
}

function atomicWriteFileSync(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.mem_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`)
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "w" })
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}
