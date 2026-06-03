import type { AgentEvent } from "@live2d-agent/agent-core";
declare const api: {
    sendUserMessage: (text: string) => Promise<any>;
    approveAction: (actionId: string) => Promise<any>;
    denyAction: (actionId: string, reason?: string) => Promise<any>;
    getSettings: () => Promise<any>;
    updateSettings: (patch: Record<string, unknown>) => Promise<any>;
    onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
};
export type PetAgentApi = typeof api;
export {};
//# sourceMappingURL=index.d.ts.map