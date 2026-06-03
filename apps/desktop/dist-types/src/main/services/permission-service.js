import { DEFAULT_PERMISSION_POLICY } from "@live2d-agent/shared";
export class PermissionService {
    settings;
    pending;
    toolDefinitions = new Map();
    approvedOnce = new Set();
    pendingListener;
    constructor(settings) {
        this.settings = settings;
    }
    setToolDefinitions(definitions) {
        this.toolDefinitions = new Map(definitions.map((definition) => [definition.name, definition]));
    }
    onPending(listener) {
        this.pendingListener = listener;
    }
    async check(actions) {
        const mode = this.settings.get().mode;
        if (mode === "auto")
            return { status: "approved", actions };
        if (mode === "manual")
            return { status: "denied", actions, reason: "manual mode blocks tool execution" };
        const requiresApproval = actions.filter((action) => !this.canAutoApprove(action));
        if (requiresApproval.length === 0)
            return { status: "approved", actions };
        this.pendingListener?.({ event: { type: "approval.pending", actions: requiresApproval } });
        return new Promise((resolve) => {
            this.pending = { actions, resolve };
        });
    }
    approve(actionId) {
        if (!this.pending)
            return;
        const action = this.pending.actions.find((item) => item.id === actionId);
        if (action)
            this.approvedOnce.add(action.tool);
        this.pendingListener?.({ event: { type: "approval.approved", actionIds: [actionId] } });
        this.pending.resolve({ status: "approved", actions: this.pending.actions });
        this.pending = undefined;
    }
    deny(actionId, reason) {
        if (!this.pending)
            return;
        const denied = this.pending.actions.find((action) => action.id === actionId);
        this.pending.resolve({
            status: "denied",
            actions: denied ? [denied] : this.pending.actions,
            reason,
        });
        this.pendingListener?.({ event: { type: "approval.denied", actionIds: [actionId], reason } });
        this.pending = undefined;
    }
    canAutoApprove(action) {
        const permission = this.toolDefinitions.get(action.tool)?.permission ?? "dangerous";
        const policy = DEFAULT_PERMISSION_POLICY[permission];
        return policy === "auto" || (policy === "confirm_once_per_session" && this.approvedOnce.has(action.tool));
    }
}
//# sourceMappingURL=permission-service.js.map