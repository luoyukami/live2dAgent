import type { ToolDefinition, PermissionLevel } from "@live2d-agent/agent-core"
import type { RuntimeToolContext } from "./runtime.js"

export const shellToolDefinition: ToolDefinition = {
  name: "shell.run",
  description: "Run a PowerShell (pwsh) command inside the configured workspace.",
  permission: "shell" as PermissionLevel,
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The PowerShell command to execute",
      },
      cwd: {
        type: "string",
        description: "Working directory (must be within the allowed workspace)",
      },
    },
    required: ["command"],
  },
}

export async function executeShellTool(
  context: RuntimeToolContext,
  args: { command: string; cwd?: string },
): Promise<string> {
  const result = await context.runShell(args.command, args.cwd)
  const parts: string[] = []

  if (result.stdout) {
    parts.push(`STDOUT:\n${result.stdout}`)
  }
  if (result.stderr) {
    parts.push(`STDERR:\n${result.stderr}`)
  }
  parts.push(`Exit code: ${result.exitCode}`)

  return parts.join("\n\n")
}
