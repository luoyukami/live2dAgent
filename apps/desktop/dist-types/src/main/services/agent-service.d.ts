import { type AgentEvent, type AgentAction, type ToolResult, type ToolRuntime } from "@live2d-agent/agent-core";
import type { PermissionService } from "./permission-service.js";
import type { SettingsService } from "./settings-service.js";
import type { TraceService } from "./trace-service.js";
export interface AgentServiceDeps {
    settings: SettingsService;
    trace: TraceService;
    permissions: PermissionService;
}
export declare class AgentService implements ToolRuntime {
    private readonly deps;
    private session?;
    private events;
    private executors;
    constructor(deps: AgentServiceDeps);
    onEvent(listener: (event: AgentEvent) => void): () => void;
    reconfigure(): void;
    sendUserMessage(text: string): Promise<void>;
    executeMany(actions: AgentAction[]): Promise<ToolResult[]>;
    private execute;
    private createExecutors;
    private createRuntimeContext;
    private resolveWorkspacePath;
    private result;
}
//# sourceMappingURL=agent-service.d.ts.map