import type { ToolDefinition, PermissionLevel } from "@live2d-agent/agent-core"
import type { RuntimeToolContext } from "./runtime.js"

export const screenshotToolDefinition: ToolDefinition = {
  name: "screenshot.capture",
  description: "Capture the current screen and return an image observation.",
  permission: "screen_read" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      displayId: {
        type: "string",
        description: "Optional identifier for a specific display",
      },
    },
  },
}

export async function executeScreenshotTool(
  context: RuntimeToolContext,
  args: { displayId?: string },
): Promise<string> {
  const result = await context.captureScreenshot(args.displayId)
  return `Screenshot captured (${result.mimeType}, ${result.data.length} bytes)`
}
