import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
const r = (path) => resolve(__dirname, path);
const root = (path) => resolve(__dirname, "../..", path);
const aliases = {
    "@desktop": r("src"),
    "@live2d-agent/shared": root("packages/shared/src/index.ts"),
    "@live2d-agent/agent-core": root("packages/agent-core/src/index.ts"),
    "@live2d-agent/tools": root("packages/tools/src/index.ts"),
    "@live2d-agent/model-openai-compatible": root("packages/model-openai-compatible/src/index.ts"),
    "@live2d-agent/live2d": root("packages/live2d/src/index.ts"),
};
export default defineConfig({
    main: {
        resolve: {
            alias: aliases,
        },
    },
    preload: {
        resolve: {
            alias: aliases,
        },
    },
    renderer: {
        plugins: [react()],
        resolve: {
            alias: aliases,
        },
    },
});
//# sourceMappingURL=electron.vite.config.js.map