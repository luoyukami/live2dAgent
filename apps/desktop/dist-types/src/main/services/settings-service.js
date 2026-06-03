import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export class SettingsService {
    userDataDir;
    settings;
    file;
    constructor(userDataDir) {
        this.userDataDir = userDataDir;
        this.file = join(userDataDir, "settings.json");
        mkdirSync(userDataDir, { recursive: true });
        const workspaceDir = join(userDataDir, "workspace");
        mkdirSync(workspaceDir, { recursive: true });
        this.settings = {
            mode: "confirm",
            workspaceDir,
            openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
            openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
            openaiApiKey: process.env.OPENAI_API_KEY,
        };
        if (existsSync(this.file)) {
            this.settings = { ...this.settings, ...JSON.parse(readFileSync(this.file, "utf8")) };
        }
        else {
            this.persist();
        }
    }
    get() {
        return { ...this.settings };
    }
    getPublicSettings() {
        const { openaiApiKey: _key, ...publicSettings } = this.settings;
        return { ...publicSettings, hasApiKey: Boolean(this.settings.openaiApiKey) };
    }
    update(patch) {
        this.settings = { ...this.settings, ...patch };
        if (patch.workspaceDir)
            mkdirSync(patch.workspaceDir, { recursive: true });
        this.persist();
    }
    persist() {
        writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8");
    }
}
//# sourceMappingURL=settings-service.js.map