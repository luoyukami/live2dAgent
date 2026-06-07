/**
 * MiMo/OpenAI-Compatible Tool Schema Encoder.
 *
 * Converts an array of CanonicalToolDefinition into the provider wire format:
 *
 * ```json
 * { "type": "function", "name": "...", "description": "...", "parameters": {...} }
 * ```
 *
 * Filters out internal-only fields (permission, execute, timeoutMs, riskLevel,
 * workspaceRoot, etc.) and sorts tools by name for stable requests.
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §8.2
 */

import type { CanonicalToolDefinition } from "@live2d-agent/agent-core"

/**
 * Provider wire format for a tool definition.
 * This is what gets sent in the `tools` array of the response.create payload.
 */
export interface ProviderToolSchema {
  type: "function"
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Encode an array of CanonicalToolDefinition into provider wire format.
 *
 * Filtering rules:
 *   - Only include `name`, `description`, `parameters` from the canonical form.
 *   - Strip internal fields: permission, execute, timeoutMs, riskLevel,
 *     workspaceRoot, and any key starting with `_`.
 *   - Sort by `name` in ascending lexicographic order (stable request).
 *
 * @param tools - Array of internal tool definitions.
 * @returns Provider-ready tool schemas, sorted by name.
 */
export function encodeTools(tools: CanonicalToolDefinition[]): ProviderToolSchema[] {
  const INTERNAL_KEYS = new Set([
    "permission",
    "execute",
    "timeoutMs",
    "timeout_ms",
    "riskLevel",
    "risk_level",
    "workspaceRoot",
    "workspace_root",
    "handler",
    "_internal",
  ])

  // Clone and filter each tool definition
  const encoded: ProviderToolSchema[] = tools
    .map((tool) => {
      // Copy only allowed fields from parameters
      const cleanParams: Record<string, unknown> = {}
      if (tool.parameters && typeof tool.parameters === "object") {
        for (const [key, value] of Object.entries(tool.parameters)) {
          if (!INTERNAL_KEYS.has(key) && !key.startsWith("_")) {
            cleanParams[key] = value
          }
        }
      }

      return {
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: cleanParams,
      }
    })
    // Filter out any tools that ended up with empty/undefined names
    .filter((t) => t.name.length > 0)

  // Sort by name lexicographically for stable request ordering
  encoded.sort((a, b) => a.name.localeCompare(b.name))

  return encoded
}
