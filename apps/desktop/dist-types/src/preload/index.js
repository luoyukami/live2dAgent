import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "@live2d-agent/shared";
const api = {
    sendUserMessage: (text) => ipcRenderer.invoke(IPC_CHANNELS.SEND_USER_MESSAGE, text),
    approveAction: (actionId) => ipcRenderer.invoke(IPC_CHANNELS.APPROVE_ACTION, actionId),
    denyAction: (actionId, reason) => ipcRenderer.invoke(IPC_CHANNELS.DENY_ACTION, actionId, reason),
    getSettings: () => ipcRenderer.invoke("settings:get"),
    updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
    onAgentEvent: (listener) => {
        const wrapped = (_event, payload) => listener(payload);
        ipcRenderer.on(IPC_CHANNELS.ON_AGENT_EVENT, wrapped);
        return () => {
            ipcRenderer.removeListener(IPC_CHANNELS.ON_AGENT_EVENT, wrapped);
        };
    },
};
contextBridge.exposeInMainWorld("petAgent", api);
//# sourceMappingURL=index.js.map