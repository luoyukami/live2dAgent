import { useEffect, useMemo, useRef, useState } from "react"
import type { AgentEvent, AgentMessage, AgentAction } from "@live2d-agent/agent-core"
import { mapEventToState, type AvatarState } from "@live2d-agent/live2d"
import type { PublicSettings, DebugSnapshot } from "@live2d-agent/shared"
import { Live2DView } from "./live2d/Live2DView"
import { DebugPanel } from "./components/DebugPanel"

interface SettingsForm {
  mode: PublicSettings["mode"]
  openaiBaseUrl: string
  openaiModel: string
  apiKey: string
  workspaceDir: string
  live2dModelPath: string
  permissionMode: PublicSettings["permissions"]["mode"]
}

const RISK_TEXT: Record<string, string> = {
  safe: "安全操作",
  workspace_read: "读取工作区文件",
  workspace_write: "写入工作区文件，需要确认",
  screen_read: "读取屏幕截图，可能包含隐私信息",
  clipboard_read: "读取剪贴板，可能包含敏感信息",
  clipboard_write: "修改剪贴板内容",
  shell: "执行命令，可能修改文件或运行程序",
  dangerous: "高风险操作，默认拒绝",
}

function defaultForm(): SettingsForm {
  return {
    mode: "confirm",
    openaiBaseUrl: "",
    openaiModel: "",
    apiKey: "",
    workspaceDir: "",
    live2dModelPath: "",
    permissionMode: "permissive",
  }
}

export function App(): JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pending, setPending] = useState<AgentAction[]>([])
  const [status, setStatus] = useState<AvatarState>("idle")
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [form, setForm] = useState<SettingsForm>(defaultForm)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  /* ---- v0.2 Debug states ---- */
  const [showDebug, setShowDebug] = useState(false)
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null)
  const [traceEvents, setTraceEvents] = useState<Array<{ ts: number; event: AgentEvent }>>([])
  const [lastManualResult, setLastManualResult] = useState<unknown>(null)
  const [live2dReloadKey, setLive2dReloadKey] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.petAgent.getSettings().then(setSettings)
    return window.petAgent.onAgentEvent((event: AgentEvent) => {
      const nextState = mapEventToState(event)
      if (nextState) setStatus(nextState)
      if (event.type === "message.added") setMessages((items) => [...items, event.message])
      if (event.type === "approval.pending") setPending(event.actions)
      if (event.type === "approval.approved" || event.type === "approval.denied") setPending([])
    })
  }, [])

  useEffect(() => {
    if (settings) {
      setForm((prev) => ({
        ...prev,
        mode: settings.mode,
        openaiBaseUrl: settings.openaiBaseUrl,
        openaiModel: settings.openaiModel,
        workspaceDir: settings.workspaceDir,
        live2dModelPath: settings.live2d?.modelPath ?? "",
        permissionMode: settings.permissions?.mode ?? "permissive",
      }))
    }
  }, [settings])

  /* Auto-revert to idle after transient states */
  useEffect(() => {
    if (status === "success") {
      const timer = setTimeout(() => setStatus("idle"), 1500)
      return () => clearTimeout(timer)
    }
    if (status === "error") {
      const timer = setTimeout(() => setStatus("idle"), 2000)
      return () => clearTimeout(timer)
    }
  }, [status])

  /* Keyboard shortcut: Ctrl/Cmd+Shift+D */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault()
        setShowDebug((prev) => {
          const next = !prev
          if (next) {
            void refreshDebug()
          }
          return next
        })
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const assistantStateLabel = useMemo(() => ({
    idle: "空闲",
    thinking: "思考中",
    waiting_approval: "等待授权",
    running_tool: "执行工具",
    success: "完成",
    error: "出错",
  }[status]), [status])

  async function submit(): Promise<void> {
    const text = input.trim()
    if (!text || isSending) return
    setInput("")
    setIsSending(true)
    try {
      await window.petAgent.sendUserMessage(text)
    } finally {
      setIsSending(false)
    }
  }

  function clearVisibleMessages(): void {
    setMessages([])
  }

  async function saveSettings(): Promise<void> {
    try {
      setSettingsError(null)
      if (form.workspaceDir !== settings?.workspaceDir) {
        await window.petAgent.updateWorkspaceDir(form.workspaceDir)
      }
      if (form.live2dModelPath !== (settings?.live2d?.modelPath ?? "")) {
        await window.petAgent.updateLive2DModelPath(form.live2dModelPath)
      }
      if (form.apiKey.trim()) {
        await window.petAgent.updateApiKey(form.apiKey.trim())
      }

      const publicPatch: Record<string, unknown> = {}
      if (form.mode !== settings?.mode) publicPatch.mode = form.mode
      if (form.openaiBaseUrl !== settings?.openaiBaseUrl) publicPatch.openaiBaseUrl = form.openaiBaseUrl
      if (form.openaiModel !== settings?.openaiModel) publicPatch.openaiModel = form.openaiModel
      if (form.permissionMode !== settings?.permissions?.mode) publicPatch.permissions = { mode: form.permissionMode }
      if (Object.keys(publicPatch).length > 0) {
        await window.petAgent.updatePublicSettings(publicPatch)
      }

      const updated = await window.petAgent.getSettings()
      setSettings(updated)
      setForm((prev) => ({ ...prev, apiKey: "" }))
      setShowSettings(false)
    } catch (err) {
      setSettingsError("保存设置失败：" + (err as Error).message)
    }
  }

  async function clearApiKey(): Promise<void> {
    try {
      setSettingsError(null)
      await window.petAgent.updateApiKey("")
      const updated = await window.petAgent.getSettings()
      setSettings(updated)
      setForm((prev) => ({ ...prev, apiKey: "" }))
    } catch (err) {
      setSettingsError("清除 API Key 失败：" + (err as Error).message)
    }
  }

  /* ---- Debug helpers ---- */
  async function refreshDebug(): Promise<void> {
    try {
      const snap = await window.petAgent.getDebugSnapshot()
      setSnapshot(snap)
      setLastManualResult(snap.lastToolResult)
    } catch {
      // ignore
    }
    try {
      const trace = await window.petAgent.getTraceEvents()
      setTraceEvents(trace)
    } catch {
      // ignore
    }
  }

  async function handleRunManualAction(tool: string, args: unknown): Promise<void> {
    await window.petAgent.runManualAction(tool, args)
    // give main process a moment to update snapshot/trace
    await new Promise((r) => setTimeout(r, 400))
    await refreshDebug()
  }

  function fillInput(text: string): void {
    setInput(text)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  async function sendFromPreset(text: string): Promise<void> {
    if (isSending) return
    setInput("")
    setIsSending(true)
    try {
      await window.petAgent.sendUserMessage(text)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <main className="shell">
      <section className="avatar" data-state={status}>
        <div className="drag-region" />
        <Live2DView key={live2dReloadKey} modelPath={settings?.live2d?.modelPath ?? ""} avatarState={status} />
        <span>{assistantStateLabel}</span>
      </section>

      <section className="panel">
        <header>
          <div>
            <strong>Pet Agent v0</strong>
            <small>
              {settings?.hasApiKey
                ? `${settings.openaiModel} · API Key 已配置`
                : "API Key 未配置 · 请在设置中填写"}
            </small>
          </div>
          <div className="header-actions">
            <select
              value={settings?.mode ?? "confirm"}
              onChange={async (event) => {
                const mode = event.target.value as PublicSettings["mode"]
                await window.petAgent.updatePublicSettings({ mode })
                setSettings(settings ? { ...settings, mode } : settings)
              }}
            >
              <option value="manual">manual</option>
              <option value="confirm">confirm</option>
              <option value="auto">auto</option>
            </select>
            <button className="icon-btn" onClick={() => { setShowDebug((s) => { if (!s) void refreshDebug(); return !s }); setShowSettings(false) }} title="Debug (Ctrl+Shift+D)">
              🐛
            </button>
            <button className="icon-btn" onClick={() => { setShowSettings((s) => !s); setSettingsError(null); setShowDebug(false) }} title="设置">
              ⚙
            </button>
            <button className="icon-btn" onClick={clearVisibleMessages} title="仅清空当前显示，不删除 trace">
              清空
            </button>
          </div>
        </header>

        {showSettings && (
          <div className="settings-panel">
            <div className="settings-header">
              <b>设置</b>
              <button className="icon-btn" onClick={() => setShowSettings(false)} title="关闭">
                ✕
              </button>
            </div>

            <div className="settings-body">
              <div className="settings-group">
                <label>运行模式</label>
                <select
                  value={form.mode}
                  onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as PublicSettings["mode"] }))}
                >
                  <option value="manual">manual</option>
                  <option value="confirm">confirm</option>
                  <option value="auto">auto</option>
                </select>
              </div>

              <div className="settings-group">
                <label>工具权限</label>
                <select
                  value={form.permissionMode}
                  onChange={(e) => setForm((f) => ({ ...f, permissionMode: e.target.value as PublicSettings["permissions"]["mode"] }))}
                >
                  <option value="permissive">默许模式</option>
                  <option value="ask">询问模式</option>
                </select>
              </div>

              <div className="settings-group">
                <label>API Key</label>
                <div className="settings-row">
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                    placeholder="输入新的 API Key（留空表示不修改）"
                  />
                  <span className={`badge ${settings?.hasApiKey ? "ok" : "warn"}`}>
                    {settings?.hasApiKey ? "已配置" : "未配置"}
                  </span>
                  <button className="ghost-btn" onClick={() => void clearApiKey()} disabled={!settings?.hasApiKey}>
                    清除
                  </button>
                </div>
              </div>

              <div className="settings-group">
                <label>Base URL</label>
                <input
                  value={form.openaiBaseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, openaiBaseUrl: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div className="settings-group">
                <label>模型</label>
                <input
                  value={form.openaiModel}
                  onChange={(e) => setForm((f) => ({ ...f, openaiModel: e.target.value }))}
                  placeholder="gpt-4o-mini"
                />
              </div>

              <div className="settings-group">
                <label>Workspace 目录</label>
                <input
                  value={form.workspaceDir}
                  onChange={(e) => setForm((f) => ({ ...f, workspaceDir: e.target.value }))}
                  placeholder="Workspace 路径"
                />
              </div>

              <div className="settings-group">
                <label>Live2D 模型路径</label>
                <input
                  value={form.live2dModelPath}
                  onChange={(e) => setForm((f) => ({ ...f, live2dModelPath: e.target.value }))}
                  placeholder="model.json 或 .model3.json 路径"
                />
              </div>
            </div>

            {settingsError && <div className="settings-error">{settingsError}</div>}
            <div className="settings-footer">
              <button onClick={() => void saveSettings()}>保存</button>
            </div>
          </div>
        )}

        {showDebug && (
          <DebugPanel
            snapshot={snapshot}
            traceEvents={traceEvents}
            onRefresh={refreshDebug}
            onOpenTraceFolder={() => void window.petAgent.openTraceFolder()}
            onOpenArtifactFolder={() => void window.petAgent.openArtifactFolder()}
            onOpenPromptFolder={() => void window.petAgent.openPromptFolder()}
            onReloadSettings={async () => {
              try {
                const s = await window.petAgent.reloadSettings()
                setSettings(s)
              } catch (err) {
                alert("reloadSettings 失败: " + (err as Error).message)
              }
            }}
            onReloadPrompt={() => void window.petAgent.reloadPrompt()}
            onReloadLive2D={async () => {
              await window.petAgent.reloadLive2D()
              setLive2dReloadKey((key) => key + 1)
            }}
            onClearMessages={clearVisibleMessages}
            onRunManualAction={handleRunManualAction}
            lastManualResult={lastManualResult}
            onFillInput={fillInput}
            onSendMessage={sendFromPreset}
            onClose={() => setShowDebug(false)}
          />
        )}

        <div className="messages">
          {messages
            .filter((message) => message.role !== "system")
            .map((message) => <MessageBubble key={message.id} message={message} />)}
        </div>

        {pending.map((action) => (
          <ApprovalBubble key={action.id} action={action} />
        ))}

        <footer>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder="输入消息..."
          />
          <button onClick={() => void submit()} disabled={isSending}>{isSending ? "发送中" : "发送"}</button>
        </footer>
        <small className="status-line">
          {status === "thinking" ? "助手正在思考..." : status === "running_tool" ? "工具执行中..." : "Enter 发送，Shift+Enter 换行"}
        </small>
      </section>
    </main>
  )
}

function MessageBubble({ message }: { message: AgentMessage }): JSX.Element {
  const [expanded, setExpanded] = useState(message.role !== "tool")
  const text = messageContentToText(message)
  const isError = Boolean(message.extra?.error) || /^(API error|Network error|Invalid JSON|Model returned|Error executing)/i.test(text)

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
  }

  return (
    <article className={`bubble ${message.role} ${isError ? "error" : ""}`}>
      <div className="message-head">
        <b>{message.role}</b>
        <div className="message-actions">
          {message.role === "tool" && (
            <button className="ghost-btn" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "折叠" : "展开"}
            </button>
          )}
          <button className="ghost-btn" onClick={() => void copy()}>复制</button>
        </div>
      </div>
      {expanded ? <p>{text}</p> : <p className="tool-summary">{summarize(text, 160)}</p>}
    </article>
  )
}

function ApprovalBubble({ action }: { action: AgentAction }): JSX.Element {
  const risk = riskForTool(action.tool)
  const args = asRecord(action.args)
  const allowLabel = risk === "screen_read" ? "允许本会话" : "允许"

  return (
    <article className="approval">
      <div className="approval-head">
        <b>请求权限：{action.tool}</b>
        <span className={`risk-badge ${risk}`}>{risk}</span>
      </div>
      <small>{RISK_TEXT[risk]}</small>
      <div className="approval-summary">{renderActionSummary(action.tool, args)}</div>
      <details>
        <summary>查看完整参数</summary>
        <code>{JSON.stringify(action.args, null, 2)}</code>
      </details>
      <div className="approval-actions">
        <button onClick={() => window.petAgent.approveAction(action.id)}>{allowLabel}</button>
        <button className="danger-btn" onClick={() => window.petAgent.denyAction(action.id, "User denied this tool-call round")}>拒绝本轮工具调用</button>
      </div>
    </article>
  )
}

function renderActionSummary(tool: string, args: Record<string, unknown>): JSX.Element {
  if (tool === "shell.run") {
    return <><span>命令：{String(args.command ?? "")}</span><span>工作目录：{String(args.cwd ?? "workspace")}</span></>
  }
  if (tool === "file.write") {
    return <><span>目标路径：{String(args.path ?? "")}</span><span>内容摘要：{summarize(String(args.content ?? ""), 180)}</span></>
  }
  if (tool === "file.read") return <span>读取路径：{String(args.path ?? "")}</span>
  if (tool === "clipboard.read") return <span>助手请求读取剪贴板，可能包含密码、令牌或隐私内容。</span>
  if (tool === "clipboard.write") return <span>写入剪贴板：{summarize(String(args.text ?? ""), 180)}</span>
  if (tool === "screenshot.capture") return <span>助手请求读取当前屏幕截图用于分析屏幕内容。</span>
  return <span>{summarize(JSON.stringify(args), 220)}</span>
}

function messageContentToText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content.map((block) => {
    if (block.type === "text") return block.text ?? ""
    if (block.type === "image_url") return "[图片输入]"
    return JSON.stringify(block)
  }).filter(Boolean).join("\n")
}

function riskForTool(tool: string): string {
  if (tool === "shell.run") return "shell"
  if (tool === "file.write") return "workspace_write"
  if (tool === "file.read") return "workspace_read"
  if (tool === "clipboard.read") return "clipboard_read"
  if (tool === "clipboard.write") return "clipboard_write"
  if (tool === "screenshot.capture") return "screen_read"
  if (tool === "task.finish") return "safe"
  return "dangerous"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function summarize(text: string, max = 240): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}
