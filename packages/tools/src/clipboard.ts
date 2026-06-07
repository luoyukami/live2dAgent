import type { ToolDefinition, PermissionLevel } from "@live2d-agent/agent-core"
import type { RuntimeToolContext } from "./runtime.js"

export const clipboardReadToolDefinition: ToolDefinition = {
  name: "clipboard.read",
  description: "Read text from the system clipboard only when the user explicitly asks to inspect the clipboard.",
  permission: "clipboard_read" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {},
  },
}

export const clipboardWriteToolDefinition: ToolDefinition = {
  name: "clipboard.write",
  description: "Write text to the system clipboard only when the user explicitly asks to copy something. Do not use this to answer the user.",
  permission: "clipboard_write" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to write to the system clipboard",
      },
    },
    required: ["text"],
  },
}

export async function executeClipboardReadTool(
  context: RuntimeToolContext,
): Promise<string> {
  const text = await context.readClipboard()
  return `Clipboard content:\n${text}`
}

export async function executeClipboardWriteTool(
  context: RuntimeToolContext,
  args: { text: string },
): Promise<string> {
  await context.writeClipboard(args.text)
  return "Clipboard updated successfully"
}
