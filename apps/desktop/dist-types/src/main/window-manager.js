import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "@live2d-agent/shared";
const isDev = process.env.NODE_ENV === "development";
export class WindowManager {
    win;
    async create() {
        const display = screen.getPrimaryDisplay();
        const { width, height } = display.workAreaSize;
        this.win = new BrowserWindow({
            width: 420,
            height: 620,
            x: Math.max(0, width - 460),
            y: Math.max(0, height - 660),
            transparent: true,
            frame: false,
            resizable: true,
            alwaysOnTop: true,
            skipTaskbar: false,
            hasShadow: false,
            webPreferences: {
                preload: join(__dirname, "../preload/index.mjs"),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });
        this.win.setMenuBarVisibility(false);
        if (isDev && process.env.ELECTRON_RENDERER_URL) {
            await this.win.loadURL(process.env.ELECTRON_RENDERER_URL);
            this.win.webContents.openDevTools({ mode: "detach" });
            return;
        }
        await this.win.loadFile(join(__dirname, "../renderer/index.html"));
    }
    hasWindow() {
        return !this.win?.isDestroyed();
    }
    sendAgentEvent(event) {
        this.win?.webContents.send(IPC_CHANNELS.ON_AGENT_EVENT, event);
    }
}
//# sourceMappingURL=window-manager.js.map