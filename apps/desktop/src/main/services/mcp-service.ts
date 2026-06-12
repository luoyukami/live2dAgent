import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { AgentAction, ToolDefinition, ToolResult } from "@live2d-agent/agent-core"
import type { AppSettings, McpServerSettings, PermissionLevel } from "@live2d-agent/shared"
import type { SettingsService } from "./settings-service.js"
import type { TraceService } from "./trace-service.js"

interface McpRuntimeTool {
  exposedName: string
  serverName: string
  remoteName: string
  description: string
  inputSchema: Record<string, unknown>
  permission: PermissionLevel
  timeoutMs: number
}

interface McpConnection {
  serverName: string
  client: Client
  transport: Transport
  tools: McpRuntimeTool[]
}

export class McpService {
  private connections = new Map<string, McpConnection>()
  private tools = new Map<string, McpRuntimeTool>()
  private lastErrors: Array<{ serverName: string; error: string; at: number }> = []

  constructor(
    private readonly settings: SettingsService,
    private readonly trace: TraceService,
  ) {}

  async reconfigure(): Promise<void> {
    await this.closeAll()
    const appSettings = this.settings.get()
    if (!appSettings.mcp.enabled) {
      this.appendTrace({ type: "mcp.disabled" })
      return
    }

    const servers = this.resolveServers(appSettings)
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled === false) continue
      try {
        await this.connectServer(serverName, serverConfig, appSettings.mcp.defaultTimeoutMs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.lastErrors.unshift({ serverName, error: message, at: Date.now() })
        this.lastErrors = this.lastErrors.slice(0, 10)
        this.appendTrace({
          type: "mcp.server.error",
          serverName,
          error: message,
        })
      }
    }
  }

  getDebugState(): {
    enabled: boolean
    connectedServers: string[]
    registeredToolCount: number
    registeredTools: Array<{ name: string; serverName: string; remoteName: string; permission: PermissionLevel }>
    lastErrors: Array<{ serverName: string; error: string; at: number }>
  } {
    return {
      enabled: this.settings.get().mcp.enabled,
      connectedServers: Array.from(this.connections.keys()),
      registeredToolCount: this.tools.size,
      registeredTools: Array.from(this.tools.values()).map((tool) => ({
        name: tool.exposedName,
        serverName: tool.serverName,
        remoteName: tool.remoteName,
        permission: tool.permission,
      })),
      lastErrors: [...this.lastErrors],
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.exposedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      permission: tool.permission,
    }))
  }

  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  async execute(action: AgentAction): Promise<ToolResult> {
    const startedAt = Date.now()
    const tool = this.tools.get(action.tool)
    if (!tool) return this.result(action, startedAt, false, `Unknown MCP tool: ${action.tool}`, undefined, "UNKNOWN_MCP_TOOL")
    const connection = this.connections.get(tool.serverName)
    if (!connection) return this.result(action, startedAt, false, `MCP server is not connected: ${tool.serverName}`, undefined, "MCP_SERVER_NOT_CONNECTED")

    this.appendTrace({ type: "mcp.tool.started", serverName: tool.serverName, tool: tool.remoteName, args: redact(action.args) })
    try {
      const result = await connection.client.callTool(
        { name: tool.remoteName, arguments: asObject(action.args) },
        undefined,
        { timeout: tool.timeoutMs },
      )
      const content = formatMcpToolResult(result)
      const ok = !("isError" in result && result.isError)
      const toolResult = this.result(action, startedAt, ok, content, redact(result), ok ? undefined : "MCP_TOOL_ERROR")
      this.appendTrace({
        type: ok ? "mcp.tool.finished" : "mcp.tool.error",
        serverName: tool.serverName,
        tool: tool.remoteName,
        ok,
        durationMs: Date.now() - startedAt,
      })
      return toolResult
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendTrace({ type: "mcp.tool.error", serverName: tool.serverName, tool: tool.remoteName, error: message, durationMs: Date.now() - startedAt })
      return this.result(action, startedAt, false, message, undefined, "MCP_EXECUTION_ERROR")
    }
  }

  async closeAll(): Promise<void> {
    const connections = Array.from(this.connections.values())
    this.connections.clear()
    this.tools.clear()
    await Promise.allSettled(connections.map(async (connection) => {
      try {
        await connection.client.close()
      } catch {
        await connection.transport.close?.()
      }
    }))
  }

  private async connectServer(serverName: string, config: McpServerSettings, defaultTimeoutMs: number): Promise<void> {
    const timeoutMs = normalizeTimeout(config.timeoutMs, defaultTimeoutMs)
    const client = new Client({ name: "live2d-agent", version: "0.0.0" }, { capabilities: {} })
    const transport = this.createTransport(serverName, config)

    transport.onerror = (error) => this.appendTrace({ type: "mcp.server.transport_error", serverName, error: error.message })
    transport.onclose = () => this.appendTrace({ type: "mcp.server.closed", serverName })

    this.appendTrace({ type: "mcp.server.connecting", serverName, config: redact(config) })
    await client.connect(transport, { timeout: timeoutMs })

    const listedTools = await listAllTools(client, timeoutMs)
    const tools: McpRuntimeTool[] = listedTools.map((remoteTool) => {
      const annotations = (remoteTool as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations
      const remoteName = String(remoteTool.name)
      const exposedName = `mcp__${sanitizeIdentifier(serverName)}__${sanitizeIdentifier(remoteName)}`
      return {
        exposedName,
        serverName,
        remoteName,
        description: `[MCP:${serverName}] ${remoteTool.description ?? remoteName}`,
        inputSchema: normalizeInputSchema(remoteTool.inputSchema),
        permission: classifyPermission(remoteName, annotations),
        timeoutMs,
      }
    })

    const connection: McpConnection = { serverName, client, transport, tools }
    this.connections.set(serverName, connection)
    for (const tool of tools) this.tools.set(tool.exposedName, tool)
    this.appendTrace({ type: "mcp.server.connected", serverName, tools: tools.map((tool) => ({ name: tool.exposedName, remoteName: tool.remoteName, permission: tool.permission })) })
  }

  private createTransport(serverName: string, config: McpServerSettings): Transport {
    const type = config.type ?? (config.command ? "stdio" : "streamable_http")
    if (type === "stdio") {
      if (!config.command) throw new Error(`MCP stdio server ${serverName} requires command`)
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env: { ...getDefaultEnvironment(), ...resolveEnv(config.env ?? {}) },
        stderr: "pipe",
      })
      transport.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim()
        if (text) this.appendTrace({ type: "mcp.server.stderr", serverName, text: redactString(text) })
      })
      return transport
    }

    if (!config.url) throw new Error(`MCP HTTP server ${serverName} requires url`)
    const headers = buildHeaders(config)
    const url = new URL(config.url)
    if (type === "sse") {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }) } as any,
      })
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  }

  private resolveServers(settings: AppSettings): Record<string, McpServerSettings> {
    const fromFile = readMcpConfigFile(settings.mcp.configPath)
    const merged: Record<string, McpServerSettings> = { ...fromFile, ...settings.mcp.servers }
    const search = settings.mcp.search
    if (search.enabled && search.provider === "brave" && search.autoRegisterServer) {
      const apiKey = search.braveApiKey?.trim()
      if (apiKey) {
        merged["brave-search"] = {
          enabled: true,
          type: "stdio",
          command: process.platform === "win32" ? "npx.cmd" : "npx",
          args: ["-y", "@modelcontextprotocol/server-brave-search"],
          env: { BRAVE_API_KEY: apiKey },
          timeoutMs: settings.mcp.defaultTimeoutMs,
          trust: false,
          ...(merged["brave-search"] ?? {}),
        }
      }
    }
    return merged
  }

  private appendTrace(event: Record<string, unknown>): void {
    this.trace.append(redact(event) as any)
  }

  private result(action: AgentAction, startedAt: number, ok: boolean, content: string, data?: unknown, code?: string): ToolResult {
    return {
      actionId: action.id,
      providerToolCallId: action.providerToolCallId,
      tool: action.tool,
      ok,
      content: truncate(content),
      data,
      error: ok ? undefined : { code: code ?? "MCP_ERROR", message: content, recoverable: true },
      startedAt,
      endedAt: Date.now(),
    }
  }
}

async function listAllTools(client: Client, timeoutMs: number): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown }>> {
  const all: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown }> = []
  let cursor: string | undefined
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs })
    all.push(...response.tools)
    cursor = response.nextCursor
  } while (cursor)
  return all
}

function readMcpConfigFile(configPath: string): Record<string, McpServerSettings> {
  const trimmed = configPath.trim()
  if (!trimmed) return {}
  const resolved = isAbsolute(trimmed) ? trimmed : resolve(trimmed)
  if (!existsSync(resolved)) return {}
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>
  const rawServers = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>
  const servers: Record<string, McpServerSettings> = {}
  for (const [name, value] of Object.entries(rawServers)) {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && value && typeof value === "object") {
      servers[name] = value as McpServerSettings
    }
  }
  return servers
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object") return schema as Record<string, unknown>
  return { type: "object", properties: {} }
}

function classifyPermission(name: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }): PermissionLevel {
  const lower = name.toLowerCase()
  if (annotations?.destructiveHint || /delete|remove|write|update|create|exec|shell|command|run|spawn/.test(lower)) return "shell"
  if (annotations?.readOnlyHint || /search|fetch|read|get|list|query|browse/.test(lower)) return "workspace_read"
  return "shell"
}

function buildHeaders(config: McpServerSettings): Record<string, string> {
  const headers = { ...(config.headers ?? {}) }
  if (config.bearerToken) headers.Authorization = `Bearer ${resolveEnvValue(config.bearerToken)}`
  for (const [key, value] of Object.entries(headers)) headers[key] = resolveEnvValue(value)
  return headers
}

function resolveEnv(env: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) output[key] = resolveEnvValue(value)
  return output
}

function resolveEnvValue(value: string): string {
  const exact = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/) ?? value.match(/^%([A-Za-z_][A-Za-z0-9_]*)%$/)
  if (exact) return process.env[exact[1]] ?? ""
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key) => process.env[key] ?? "")
}

function sanitizeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 64)
  return safe || "tool"
}

function normalizeTimeout(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1_000, Math.min(600_000, value)) : fallback
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function formatMcpToolResult(result: unknown): string {
  const obj = result as { content?: Array<Record<string, unknown>>; structuredContent?: unknown; toolResult?: unknown; isError?: boolean }
  const parts: string[] = []
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text)
      else if (item.type === "resource" && item.resource) parts.push(JSON.stringify(item.resource))
      else if (item.type === "resource_link") parts.push(JSON.stringify(item))
      else if (item.type === "image" || item.type === "audio") parts.push(`[${item.type} content omitted]`)
      else parts.push(JSON.stringify(item))
    }
  }
  if (obj.structuredContent !== undefined) parts.push(JSON.stringify(obj.structuredContent, null, 2))
  if (obj.toolResult !== undefined) parts.push(JSON.stringify(obj.toolResult, null, 2))
  if (parts.length === 0) parts.push(JSON.stringify(redact(result)))
  return parts.join("\n")
}

function truncate(value: string): string {
  const max = 16_000
  if (value.length <= max) return value
  return `${value.slice(0, 8_000)}\n\n[... truncated ${value.length - max} chars ...]\n\n${value.slice(-8_000)}`
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (/key|token|secret|authorization|password/i.test(key)) out[key] = "[redacted]"
      else out[key] = redact(child)
    }
    return out
  }
  if (typeof value === "string") return redactString(value)
  return value
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(sk-|brv_)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]")
}
