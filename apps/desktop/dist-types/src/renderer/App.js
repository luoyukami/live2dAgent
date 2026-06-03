import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { mapEventToState } from "@live2d-agent/live2d";
export function App() {
    const [messages, setMessages] = useState([]);
    const [pending, setPending] = useState([]);
    const [status, setStatus] = useState("idle");
    const [input, setInput] = useState("");
    const [settings, setSettings] = useState(null);
    useEffect(() => {
        window.petAgent.getSettings().then(setSettings);
        return window.petAgent.onAgentEvent((event) => {
            const nextState = mapEventToState(event);
            if (nextState)
                setStatus(nextState);
            if (event.type === "message.added")
                setMessages((items) => [...items, event.message]);
            if (event.type === "approval.pending")
                setPending(event.actions);
            if (event.type === "approval.approved" || event.type === "approval.denied")
                setPending([]);
        });
    }, []);
    const assistantStateLabel = useMemo(() => ({
        idle: "空闲",
        thinking: "思考中",
        waiting_approval: "等待授权",
        running_tool: "执行工具",
        success: "完成",
        error: "出错",
    }[status]), [status]);
    async function submit() {
        const text = input.trim();
        if (!text)
            return;
        setInput("");
        await window.petAgent.sendUserMessage(text);
    }
    return (_jsxs("main", { className: "shell", children: [_jsxs("section", { className: "avatar", "data-state": status, children: [_jsx("div", { className: "drag-region" }), _jsx("div", { className: "avatar-orb", children: "Live2D" }), _jsx("span", { children: assistantStateLabel })] }), _jsxs("section", { className: "panel", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx("strong", { children: "Pet Agent v0" }), _jsx("small", { children: settings?.hasApiKey ? settings.openaiModel : "请在 settings.json 或环境变量配置 API Key" })] }), _jsxs("select", { value: settings?.mode ?? "confirm", onChange: async (event) => {
                                    const mode = event.target.value;
                                    await window.petAgent.updateSettings({ mode });
                                    setSettings(settings ? { ...settings, mode } : settings);
                                }, children: [_jsx("option", { value: "manual", children: "manual" }), _jsx("option", { value: "confirm", children: "confirm" }), _jsx("option", { value: "auto", children: "auto" })] })] }), _jsx("div", { className: "messages", children: messages.map((message) => (_jsxs("article", { className: `bubble ${message.role}`, children: [_jsx("b", { children: message.role }), _jsx("p", { children: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })] }, message.id))) }), pending.map((action) => (_jsxs("article", { className: "approval", children: [_jsxs("b", { children: ["\u8BF7\u6C42\u6743\u9650\uFF1A", action.tool] }), _jsx("code", { children: JSON.stringify(action.args, null, 2) }), _jsxs("div", { children: [_jsx("button", { onClick: () => window.petAgent.approveAction(action.id), children: "\u5141\u8BB8" }), _jsx("button", { onClick: () => window.petAgent.denyAction(action.id, "User denied"), children: "\u62D2\u7EDD" })] })] }, action.id))), _jsxs("footer", { children: [_jsx("input", { value: input, onChange: (event) => setInput(event.target.value), onKeyDown: (event) => { if (event.key === "Enter")
                                    void submit(); }, placeholder: "\u8F93\u5165\u6D88\u606F..." }), _jsx("button", { onClick: () => void submit(), children: "\u53D1\u9001" })] })] })] }));
}
//# sourceMappingURL=App.js.map