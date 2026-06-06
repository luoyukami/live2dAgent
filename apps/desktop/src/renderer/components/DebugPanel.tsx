import { useState } from "react"
import type { DebugSnapshot } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import { TraceViewer } from "./TraceViewer"
import { ManualActionInjector } from "./ManualActionInjector"
import { ScenarioPresets } from "./ScenarioPresets"

type Tab = "overview" | "trace" | "manual" | "presets"

interface Props {
  snapshot: DebugSnapshot | null
  traceEvents: Array<{ ts: number; event: AgentEvent }>
  onRefresh: () => void
  onOpenTraceFolder: () => void
  onOpenArtifactFolder: () => void
  onOpenPromptFolder: () => void
  onReloadSettings: () => void
  onReloadPrompt: () => void
  onReloadLive2D: () => void
  onClearMessages: () => void
  onRunManualAction: (tool: string, args: unknown) => void
  lastManualResult: unknown
  onFillInput: (text: string) => void
  onSendMessage: (text: string) => void
  onClose: () => void
}

export function DebugPanel({
  snapshot,
  traceEvents,
  onRefresh,
  onOpenTraceFolder,
  onOpenArtifactFolder,
  onOpenPromptFolder,
  onReloadSettings,
  onReloadPrompt,
  onReloadLive2D,
  onClearMessages,
  onRunManualAction,
  lastManualResult,
  onFillInput,
  onSendMessage,
  onClose,
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>("overview")

  async function copySummary(): Promise<void> {
    if (!snapshot) return
    const payload = {
      model: snapshot.model,
      baseURL: snapshot.baseURL,
      workspace: snapshot.workspace,
      mode: snapshot.mode,
      permissionMode: snapshot.permissionMode,
      maxSteps: snapshot.maxSteps,
      avatarState: snapshot.avatarState,
      tracePath: snapshot.tracePath,
      promptError: snapshot.promptError,
    }
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
  }

  async function copyField(field: "lastModelRequest" | "lastModelResponse" | "lastToolResult"): Promise<void> {
    if (!snapshot) return
    const value = snapshot[field]
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
  }

  const recentEvents = snapshot?.recentEvents ?? []

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <b>Debug Panel</b>
        <div className="debug-tabs">
          <button className={`ghost-btn ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>概览</button>
          <button className={`ghost-btn ${tab === "trace" ? "active" : ""}`} onClick={() => setTab("trace")}>Trace</button>
          <button className={`ghost-btn ${tab === "manual" ? "active" : ""}`} onClick={() => setTab("manual")}>手动执行</button>
          <button className={`ghost-btn ${tab === "presets" ? "active" : ""}`} onClick={() => setTab("presets")}>场景预设</button>
        </div>
        <div className="debug-actions">
          <button className="ghost-btn" onClick={() => void onRefresh()} title="刷新数据">刷新</button>
          <button className="ghost-btn" onClick={() => void onClose()} title="关闭">✕</button>
        </div>
      </div>

      <div className="debug-body">
        {tab === "overview" && (
          <div className="debug-overview">
            <section className="debug-section">
              <h4>运行环境</h4>
              <div className="debug-kv">
                <div><span>模型</span><span>{snapshot?.model ?? "—"}</span></div>
                <div><span>Base URL</span><span>{snapshot?.baseURL ?? "—"}</span></div>
                <div><span>Workspace</span><span>{snapshot?.workspace ?? "—"}</span></div>
                <div><span>Mode</span><span>{snapshot?.mode ?? "—"}</span></div>
                <div><span>Permission</span><span>{snapshot?.permissionMode ?? "—"}</span></div>
                <div><span>Max Steps</span><span>{snapshot?.maxSteps ?? "—"}</span></div>
                <div><span>Avatar State</span><span>{snapshot?.avatarState ?? "—"}</span></div>
                <div><span>Trace Path</span><span>{snapshot?.tracePath ?? "—"}</span></div>
              </div>
            </section>

            <section className="debug-section">
              <h4>情绪系统</h4>
              <div className="debug-kv">
                <div><span>Emotion enabled</span><span>{snapshot?.emotion?.enabled ? "true" : "false"}</span></div>
                <div><span>Prompt injected</span><span>{snapshot?.emotion?.promptInjected ? "true" : "false"}</span></div>
                <div><span>Default emotion</span><span>{snapshot?.emotion?.defaultEmotion ?? "—"}</span></div>
                <div><span>Last emotion</span><span>{snapshot?.emotion?.lastEmotion ?? "—"}</span></div>
                <div><span>Emotion source</span><span>{snapshot?.emotion?.lastSource ?? "—"}</span></div>
                <div><span>Raw tag</span><span>{snapshot?.emotion?.lastRawTag ?? "none"}</span></div>
                <div><span>Parse warning</span><span>{snapshot?.emotion?.lastParseWarning ?? "none"}</span></div>
                <div><span>Inject prompt setting</span><span>{snapshot?.emotion?.injectPrompt ? "true" : "false"}</span></div>
              </div>
            </section>

            <section className="debug-section">
              <h4>最近 AgentEvent</h4>
              <div className="debug-events">
                {recentEvents.length === 0 && <small>暂无事件</small>}
                {recentEvents.slice(-10).map((e, i) => {
                  const ev = e.event as Record<string, unknown>
                  return (
                    <div key={i} className="debug-event-row">
                      <span className="trace-ts">{new Date(e.ts).toLocaleTimeString()}</span>
                      <span className="trace-type">{String(ev.type ?? "unknown")}</span>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="debug-section">
              <h4>Last 模型交互 / 工具</h4>
              <div className="debug-last-items">
                <details>
                  <summary>Last Model Request</summary>
                  <pre className="trace-json">{JSON.stringify(snapshot?.lastModelRequest ?? null, null, 2)}</pre>
                </details>
                <details>
                  <summary>Last Model Response</summary>
                  <pre className="trace-json">{JSON.stringify(snapshot?.lastModelResponse ?? null, null, 2)}</pre>
                </details>
                <details>
                  <summary>Last Tool Call</summary>
                  <pre className="trace-json">{JSON.stringify(snapshot?.lastToolCall ?? null, null, 2)}</pre>
                </details>
                <details>
                  <summary>Last Permission</summary>
                  <pre className="trace-json">{JSON.stringify(snapshot?.lastPermission ?? null, null, 2)}</pre>
                </details>
                <details>
                  <summary>Last Tool Result</summary>
                  <pre className="trace-json">{JSON.stringify(snapshot?.lastToolResult ?? null, null, 2)}</pre>
                </details>
              </div>
              <div className="debug-actions-row">
                <button className="ghost-btn" onClick={() => void copyField("lastModelRequest")}>复制 Request</button>
                <button className="ghost-btn" onClick={() => void copyField("lastModelResponse")}>复制 Response</button>
                <button className="ghost-btn" onClick={() => void copyField("lastToolResult")}>复制 Tool Result</button>
              </div>
            </section>

            <section className="debug-section">
              <h4>Prompt</h4>
              <div className="debug-prompt">
                {snapshot?.promptError ? (
                  <div className="settings-error">{snapshot.promptError}</div>
                ) : null}
                <pre className="trace-json prompt-preview">{snapshot?.systemPromptPreview ?? "—"}</pre>
              </div>
            </section>

            <section className="debug-section">
              <h4>快捷操作</h4>
              <div className="debug-actions-row">
                <button className="ghost-btn" onClick={() => void copySummary()}>复制调试摘要</button>
                <button className="ghost-btn" onClick={() => void onOpenTraceFolder()}>打开 trace 文件夹</button>
                <button className="ghost-btn" onClick={() => void onOpenArtifactFolder()}>打开 artifact 文件夹</button>
                <button className="ghost-btn" onClick={() => void onOpenPromptFolder()}>打开 prompt 文件夹</button>
                <button className="ghost-btn" onClick={() => void onReloadSettings()}>Reload Settings</button>
                <button className="ghost-btn" onClick={() => void onReloadPrompt()}>Reload Prompt</button>
                <button className="ghost-btn" onClick={() => void onReloadLive2D()}>Reload Live2D</button>
                <button className="ghost-btn danger" onClick={() => { onClearMessages(); void onRefresh(); }}>清空 UI 消息</button>
              </div>
            </section>
          </div>
        )}

        {tab === "trace" && (
          <TraceViewer events={traceEvents} onOpenFolder={onOpenTraceFolder} />
        )}

        {tab === "manual" && (
          <ManualActionInjector onRun={onRunManualAction} lastResult={lastManualResult} />
        )}

        {tab === "presets" && (
          <ScenarioPresets onFill={onFillInput} onSend={onSendMessage} onClose={onClose} />
        )}
      </div>
    </div>
  )
}
