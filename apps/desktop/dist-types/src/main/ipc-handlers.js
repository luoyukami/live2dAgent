import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@live2d-agent/shared";
export function registerIpcHandlers(services) {
    ipcMain.handle(IPC_CHANNELS.SEND_USER_MESSAGE, async (_event, text) => {
        await services.agent.sendUserMessage(text);
    });
    ipcMain.handle(IPC_CHANNELS.APPROVE_ACTION, async (_event, actionId) => {
        services.permissions.approve(actionId);
    });
    ipcMain.handle(IPC_CHANNELS.DENY_ACTION, async (_event, actionId, reason) => {
        services.permissions.deny(actionId, reason);
    });
    ipcMain.handle(IPC_CHANNELS.SET_AGENT_MODE, async (_event, mode) => {
        services.settings.update({ mode });
    });
    ipcMain.handle("settings:get", async () => services.settings.getPublicSettings());
    ipcMain.handle("settings:update", async (_event, patch) => {
        services.settings.update(patch);
        services.agent.reconfigure();
    });
}
//# sourceMappingURL=ipc-handlers.js.map