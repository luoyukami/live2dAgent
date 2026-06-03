import type { ToolDefinition } from "./types.js"

/**
 * Registry that holds tool *definitions* (metadata exposed to the model).
 *
 * The actual execution capability lives outside this package (in the Electron
 * main process), injected via the ToolRuntime interface passed to AgentSession.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  /** Register one or more tool definitions. Throws on duplicate names. */
  register(...definitions: ToolDefinition[]): void {
    for (const def of definitions) {
      if (this.tools.has(def.name)) {
        throw new Error(`Tool "${def.name}" is already registered`)
      }
      this.tools.set(def.name, def)
    }
  }

  /** Look up a definition by name. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** Return all registered definitions (e.g. to pass to ModelAdapter.query). */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /** Check if a tool name has been registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }
}
