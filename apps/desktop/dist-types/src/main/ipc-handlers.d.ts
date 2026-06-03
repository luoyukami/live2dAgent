import type { AgentService } from "./services/agent-service.js";
import type { PermissionService } from "./services/permission-service.js";
import type { SettingsService } from "./services/settings-service.js";
export interface IpcServices {
    agent: AgentService;
    permissions: PermissionService;
    settings: SettingsService;
}
export declare function registerIpcHandlers(services: IpcServices): void;
//# sourceMappingURL=ipc-handlers.d.ts.map