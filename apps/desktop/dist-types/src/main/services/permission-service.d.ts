import type { AgentAction, AgentEvent, PermissionController, ToolDefinition } from "@live2d-agent/agent-core";
import type { SettingsService } from "./settings-service.js";
export declare class PermissionService implements PermissionController {
    private readonly settings;
    private pending?;
    private toolDefinitions;
    private approvedOnce;
    private pendingListener?;
    constructor(settings: SettingsService);
    setToolDefinitions(definitions: ToolDefinition[]): void;
    onPending(listener: (payload: {
        event: AgentEvent;
    }) => void): void;
    check(actions: AgentAction[]): Promise<{
        status: "approved" | "denied";
        actions: AgentAction[];
        reason?: string;
    }>;
    approve(actionId: string): void;
    deny(actionId: string, reason?: string): void;
    private canAutoApprove;
}
//# sourceMappingURL=permission-service.d.ts.map