/**
 * Tool Schema Encoder — converts CanonicalToolDefinition to provider-safe format.
 *
 * The encoder:
 *   1. Strips internal fields (permission, execute, timeoutMs, etc.).
 *   2. Sorts tools by name alphabetically for stable request ordering.
 *
 * The output is ready to be serialized into the provider's tool array.
 * The concrete encoding to the provider's wire format (e.g.
 * `{ type: "function", name, description, parameters }`) is handled
 * by the provider-specific protocol layer.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §8.2.
 */

import type { CanonicalToolDefinition } from "../model/model-tool.js"

/**
 * Internal field names that MUST be stripped before sending tool
 * schemas to a model provider.
 */
const INTERNAL_FIELD_NAMES = new Set([
  "permission",
  "execute",
  "timeoutMs",
  "riskLevel",
  "workspaceRoot",
])

/**
 * A provider-safe tool schema object.
 * Only contains fields the model needs to call the tool.
 */
export interface ProviderToolSchema {
  type: "function"
  name: string
  description: string
  parameters: unknown
}

/**
 * Encode an array of CanonicalToolDefinitions into a provider-safe format.
 *
 * Steps:
 *   1. Sort tools by name alphabetically (stable ordering).
 *   2. Remove any internal fields from the parameters schema.
 *   3. Return the encoded array.
 *
 * @param tools - Canonical tool definitions (from ToolManager).
 * @returns Provider-safe tool schema array.
 */
export function encodeToolSchemas(
  tools: CanonicalToolDefinition[],
): ProviderToolSchema[] {
  // Sort by name alphabetically for stable request ordering
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))

  return sorted.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: stripInternalFields(tool.parameters),
  }))
}

/**
 * Recursively strip internal fields from a parameter schema object.
 *
 * Internal field names are defined in INTERNAL_FIELD_NAMES.
 * These fields are often present on InternalToolDefinition but must
 * never be sent to the model.
 */
function stripInternalFields(schema: unknown): unknown {
  if (schema === null || schema === undefined) {
    return schema
  }

  if (Array.isArray(schema)) {
    return schema.map(stripInternalFields)
  }

  if (typeof schema === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (!INTERNAL_FIELD_NAMES.has(key)) {
        result[key] = stripInternalFields(value)
      }
    }
    return result
  }

  return schema
}
