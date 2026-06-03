import type { ToolResult, AgentMessage } from "./types.js"

/**
 * Default utility to convert ToolResult[] into tool-role observation messages.
 *
 * ModelAdapter implementations MAY use this or provide their own formatting.
 */
export function formatToolResultsAsObservations(
  results: ToolResult[],
): AgentMessage[] {
  return results.map((result) => ({
    id: `obs_${result.actionId}`,
    role: "tool",
    content: formatObservationContent(result),
    toolCallId: result.actionId,
    createdAt: result.endedAt,
    extra: {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    },
  }))
}

function formatObservationContent(result: ToolResult): string {
  if (!result.ok) {
    return `Error executing ${result.tool}: ${result.error?.message ?? result.content}`
  }

  const parts: string[] = [result.content]

  if (result.data !== undefined) {
    parts.push(`\n\nData: ${JSON.stringify(result.data, null, 2)}`)
  }

  if (result.artifacts && result.artifacts.length > 0) {
    parts.push(
      `\n\nArtifacts: ${result.artifacts.map((a) => a.id).join(", ")}`,
    )
  }

  return parts.join("")
}
