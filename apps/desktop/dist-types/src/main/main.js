import { app } from "electron";
import { WindowManager } from "./window-manager.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { AgentService } from "./services/agent-service.js";
import { PermissionService } from "./services/permission-service.js";
import { SettingsService } from "./services/settings-service.js";
import { TraceService } from "./services/trace-service.js";
let windowManager;
let agentService;
async function bootstrap() {
    const settings = new SettingsService(app.getPath("userData"));
    const trace = new TraceService(app.getPath("userData"));
    const permissions = new PermissionService(settings);
    windowManager = new WindowManager();
    await windowManager.create();
    permissions.onPending((request) => windowManager?.sendAgentEvent(request.event));
    agentService = new AgentService({ settings, trace, permissions });
    agentService.onEvent((event) => windowManager?.sendAgentEvent(event));
    registerIpcHandlers({ agent: agentService, permissions, settings });
}
app.whenReady().then(bootstrap);
app.on("activate", async () => {
    if (windowManager && !windowManager.hasWindow()) {
        await windowManager.create();
    }
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});
//# sourceMappingURL=main.js.map