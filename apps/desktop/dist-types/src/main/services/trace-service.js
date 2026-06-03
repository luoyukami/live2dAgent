import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
export class TraceService {
    traceFile;
    constructor(userDataDir) {
        const tracesDir = join(userDataDir, "traces");
        mkdirSync(tracesDir, { recursive: true });
        this.traceFile = join(tracesDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    }
    append(event) {
        appendFileSync(this.traceFile, `${JSON.stringify({ ts: Date.now(), event })}\n`, "utf8");
    }
}
//# sourceMappingURL=trace-service.js.map