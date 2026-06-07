import type { ToolDefinition, PermissionLevel } from "@live2d-agent/agent-core"
import type { RuntimeToolContext } from "./runtime.js"

export const taskFinishToolDefinition: ToolDefinition = {
  name: "task.finish",
  description: "Mark an explicitly delegated multi-step task as finished. Do not use for greetings, casual chat, or normal assistant replies.",
  permission: "safe" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Summary of what was accomplished",
      },
      status: {
        type: "string",
        enum: ["success", "failed", "cancelled"],
        description: "Final status of the task",
      },
    },
    required: ["summary", "status"],
  },
}

export async function executeTaskFinishTool(
  context: RuntimeToolContext,
  args: { summary: string; status: "success" | "failed" | "cancelled" },
): Promise<string> {
  await context.finishTask(args.summary, args.status)
  return `Task finished with status: ${args.status}`
}
