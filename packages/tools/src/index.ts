export type { RuntimeToolContext } from "./runtime.js"

/* ---- Individual tool definitions & executor helpers ---- */
export { shellToolDefinition, executeShellTool } from "./shell.js"
export {
  fileReadToolDefinition,
  fileWriteToolDefinition,
  executeFileReadTool,
  executeFileWriteTool,
} from "./file.js"
export {
  clipboardReadToolDefinition,
  clipboardWriteToolDefinition,
  executeClipboardReadTool,
  executeClipboardWriteTool,
} from "./clipboard.js"
export { screenshotToolDefinition, executeScreenshotTool } from "./screenshot.js"
export { taskFinishToolDefinition, executeTaskFinishTool } from "./task-finish.js"
export { memoryToolDefinition } from "./memory.js"

/* ---- Factory ---- */
import type { ToolDefinition } from "@live2d-agent/agent-core"
import { shellToolDefinition } from "./shell.js"
import { fileReadToolDefinition, fileWriteToolDefinition } from "./file.js"
import {
  clipboardReadToolDefinition,
  clipboardWriteToolDefinition,
} from "./clipboard.js"
import { screenshotToolDefinition } from "./screenshot.js"
import { taskFinishToolDefinition } from "./task-finish.js"
import { memoryToolDefinition } from "./memory.js"

/**
 * Return all v0 tool definitions for registration into a ToolRegistry.
 */
export function createDefaultTools(): ToolDefinition[] {
  return [
    shellToolDefinition,
    fileReadToolDefinition,
    fileWriteToolDefinition,
    clipboardReadToolDefinition,
    clipboardWriteToolDefinition,
    screenshotToolDefinition,
    memoryToolDefinition,
    taskFinishToolDefinition,
  ]
}
