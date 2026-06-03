import type { AgentMode } from "@live2d-agent/shared";
export interface AppSettings {
    mode: AgentMode;
    workspaceDir: string;
    openaiBaseUrl: string;
    openaiModel: string;
    openaiApiKey?: string;
}
export declare class SettingsService {
    private readonly userDataDir;
    private settings;
    private readonly file;
    constructor(userDataDir: string);
    get(): AppSettings;
    getPublicSettings(): Omit<AppSettings, "openaiApiKey"> & {
        hasApiKey: boolean;
    };
    update(patch: Partial<AppSettings>): void;
    private persist;
}
//# sourceMappingURL=settings-service.d.ts.map