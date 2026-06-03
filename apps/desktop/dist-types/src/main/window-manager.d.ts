import type { AgentEvent } from "@live2d-agent/agent-core";
export declare class WindowManager {
    private win?;
    create(): Promise<void>;
    hasWindow(): boolean;
    sendAgentEvent(event: AgentEvent): void;
}
//# sourceMappingURL=window-manager.d.ts.map