import type { ToolDefinition, PermissionLevel } from "@live2d-agent/agent-core"
import type { RuntimeToolContext } from "./runtime.js"

export const fileReadToolDefinition: ToolDefinition = {
  name: "file.read",
  description: "Read a file inside the workspace.",
  permission: "workspace_read" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to workspace root)",
      },
    },
    required: ["path"],
  },
}

export const fileWriteToolDefinition: ToolDefinition = {
  name: "file.write",
  description: "Write a file inside the workspace.",
  permission: "workspace_write" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to workspace root)",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
}

export async function executeFileReadTool(
  context: RuntimeToolContext,
  args: { path: string },
): Promise<string> {
  return await context.readFile(args.path)
}

export async function executeFileWriteTool(
  context: RuntimeToolContext,
  args: { path: string; content: string },
): Promise<string> {
  await context.writeFile(args.path, args.content)
  return `Successfully wrote ${args.path}`
}
