const DEFAULT_HISTORY_SUMMARY_LIMIT = 800

export interface BuildToolHistorySummaryInput {
  toolName: string
  status: "ok" | "error" | "denied" | string
  summary?: string
  output?: string
  artifactRef?: string
  maxChars?: number
}

export function buildToolHistorySummary(input: BuildToolHistorySummaryInput): string {
  const maxChars = input.maxChars ?? DEFAULT_HISTORY_SUMMARY_LIMIT
  const parsed = parseToolOutputPayload(input.output)
  const status = input.status || parsed.status || "unknown"
  const artifactRef = input.artifactRef ?? parsed.artifactRef
  const summarySource = firstNonEmpty(input.summary, parsed.summary, parsed.content, input.output, "No summary available.")
  const summary = clampSingleLine(summarySource, Math.max(80, Math.floor(maxChars * 0.65)))

  const lines = [
    "[Tool Result Summary]",
    `Tool: ${input.toolName || "unknown"}`,
    `Status: ${status}`,
    `Summary: ${summary}`,
    "Full output omitted from future context.",
  ]

  if (artifactRef) lines.push(`Artifact: ${artifactRef}`)

  return clampText(lines.join("\n"), maxChars)
}

export function isToolHistorySummary(content: string): boolean {
  return content.startsWith("[Tool Result Summary]")
}

function parseToolOutputPayload(output: string | undefined): {
  status?: string
  summary?: string
  content?: string
  artifactRef?: string
} {
  if (!output) return {}
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    return {
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      content: typeof parsed.content === "string" ? parsed.content : undefined,
      artifactRef: typeof parsed.artifactRef === "string" ? parsed.artifactRef : undefined,
    }
  } catch {
    return {}
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function clampSingleLine(value: string, maxChars: number): string {
  return clampText(value.replace(/\s+/g, " ").trim(), maxChars)
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const suffix = "..."
  return `${value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`
}
