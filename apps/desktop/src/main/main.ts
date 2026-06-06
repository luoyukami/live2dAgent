import { app, net, protocol } from "electron"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { WindowManager } from "./window-manager.js"
import { registerIpcHandlers } from "./ipc-handlers.js"
import { AgentService } from "./services/agent-service.js"
import { ArtifactStore } from "./services/artifact-store.js"
import { PermissionService } from "./services/permission-service.js"
import { PromptService } from "./services/prompt-service.js"
import { SettingsService } from "./services/settings-service.js"
import { TraceService } from "./services/trace-service.js"

// 增加mcp调试的默认端口暴露
const devtoolsPort = process.env.ELECTRON_REMOTE_DEBUGGING_PORT ?? "9222"

if (!app.isPackaged && process.env.ELECTRON_REMOTE_DEBUGGING !== "0") {
  app.commandLine.appendSwitch("remote-debugging-port", devtoolsPort)
}

let windowManager: WindowManager | undefined
let agentService: AgentService | undefined

protocol.registerSchemesAsPrivileged([
  {
    scheme: "live2d-local",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

function registerLive2DLocalProtocol(settings: SettingsService): void {
  protocol.handle("live2d-local", (request) => {
    const filePath = decodeLive2DLocalPath(request.url)
    if (!filePath || !existsSync(filePath)) {
      return new Response("Not found", { status: 404 })
    }

    let realTarget: string
    try {
      realTarget = realpathSync(filePath)
    } catch {
      return new Response("Not found", { status: 404 })
    }

    const allowedRoots = settings.getAllowedLive2DRoots()
    if (!allowedRoots.some((root) => isInside(root, realTarget))) {
      return new Response("Forbidden", { status: 403 })
    }

    return net.fetch(pathToFileURL(realTarget).toString())
  })
}

function decodeLive2DLocalPath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === "win32" && /^\/[a-zA-Z]:\//.test(filePath)) {
      filePath = filePath.slice(1)
    }
    return filePath
  } catch {
    return null
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath("userData")
  const settings = new SettingsService(userDataDir)
  registerLive2DLocalProtocol(settings)
  const trace = new TraceService(userDataDir)
  const permissions = new PermissionService(settings)
  const artifacts = new ArtifactStore(userDataDir)
  const prompts = new PromptService(userDataDir)

  windowManager = new WindowManager()
  await windowManager.create()

  permissions.onPending((request) => {
    trace.append(request.event)
    windowManager?.sendAgentEvent(request.event)
  })
  agentService = new AgentService({ settings, trace, permissions, artifacts, prompts })
  agentService.onEvent((event) => windowManager?.sendAgentEvent(event))

  registerIpcHandlers({ agent: agentService, permissions, settings, trace, artifacts, prompts })
}

app.whenReady().then(bootstrap)

app.on("activate", async () => {
  if (windowManager && !windowManager.hasWindow()) {
    await windowManager.create()
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
