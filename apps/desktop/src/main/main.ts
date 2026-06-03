import { app } from "electron"
import { WindowManager } from "./window-manager.js"
import { registerIpcHandlers } from "./ipc-handlers.js"
import { AgentService } from "./services/agent-service.js"
import { ArtifactStore } from "./services/artifact-store.js"
import { PermissionService } from "./services/permission-service.js"
import { SettingsService } from "./services/settings-service.js"
import { TraceService } from "./services/trace-service.js"

let windowManager: WindowManager | undefined
let agentService: AgentService | undefined

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath("userData")
  const settings = new SettingsService(userDataDir)
  const trace = new TraceService(userDataDir)
  const permissions = new PermissionService(settings)
  const artifacts = new ArtifactStore(userDataDir)

  windowManager = new WindowManager()
  await windowManager.create()

  permissions.onPending((request) => {
    trace.append(request.event)
    windowManager?.sendAgentEvent(request.event)
  })
  agentService = new AgentService({ settings, trace, permissions, artifacts })
  agentService.onEvent((event) => windowManager?.sendAgentEvent(event))

  registerIpcHandlers({ agent: agentService, permissions, settings })
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
