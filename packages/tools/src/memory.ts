import type { PermissionLevel, ToolDefinition } from "@live2d-agent/agent-core"

export const memoryToolDefinition: ToolDefinition = {
  name: "memory",
  description: [
    "Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.",
    "WHEN TO SAVE proactively: user corrections or explicit requests to remember; user preferences, habits, or personal details; stable environment, OS, tool, project, API, or workflow facts.",
    "Priority: user preferences and corrections > environment facts > procedural knowledge.",
    "Do not save task progress, session outcomes, completed-work logs, temporary TODO state, trivial facts, raw dumps, or things likely to become stale quickly.",
    "Targets: user = who the user is, preferences, communication style; memory = agent notes, environment facts, project conventions, tool quirks, lessons learned.",
    "Actions: add creates an entry; replace updates an existing entry identified by old_text; remove deletes an existing entry identified by old_text.",
  ].join("\n\n"),
  permission: "safe" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "replace", "remove"], description: "The action to perform." },
      target: { type: "string", enum: ["memory", "user"], description: "Which memory store to mutate." },
      content: { type: "string", description: "Entry content. Required for add and replace." },
      old_text: { type: "string", description: "Short unique substring identifying the entry to replace or remove." },
    },
    required: ["action", "target"],
  },
}
