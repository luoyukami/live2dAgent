import type { AgentEvent, TraceStore } from "@live2d-agent/agent-core";
export declare class TraceService implements TraceStore {
    private readonly traceFile;
    constructor(userDataDir: string);
    append(event: AgentEvent): void;
}
//# sourceMappingURL=trace-service.d.ts.map