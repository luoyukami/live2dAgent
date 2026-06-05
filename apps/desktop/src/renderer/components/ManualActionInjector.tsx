import { useState } from "react"

const TOOL_OPTIONS = [
  { value: "screenshot.capture", label: "screenshot.capture", fields: [] as string[] },
  { value: "clipboard.read", label: "clipboard.read", fields: [] as string[] },
  { value: "clipboard.write", label: "clipboard.write", fields: ["text"] },
  { value: "file.read", label: "file.read", fields: ["path"] },
  { value: "file.write", label: "file.write", fields: ["path", "content"] },
  { value: "shell.run", label: "shell.run", fields: ["command", "cwd"] },
  { value: "task.finish", label: "task.finish", fields: [] as string[] },
]

interface Props {
  onRun: (tool: string, args: unknown) => void
  lastResult: unknown
}

export function ManualActionInjector({ onRun, lastResult }: Props): JSX.Element {
  const [tool, setTool] = useState("screenshot.capture")
  const [args, setArgs] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)

  const currentTool = TOOL_OPTIONS.find((t) => t.value === tool) ?? TOOL_OPTIONS[0]

  async function handleRun(): Promise<void> {
    setRunning(true)
    try {
      const payload: Record<string, unknown> = {}
      for (const key of currentTool.fields) {
        payload[key] = args[key] ?? ""
      }
      await onRun(tool, payload)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="manual-injector">
      <div className="manual-form">
        <div className="settings-group">
          <label>工具</label>
          <select value={tool} onChange={(e) => { setTool(e.target.value); setArgs({}) }}>
            {TOOL_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {currentTool.fields.map((field) => (
          <div key={field} className="settings-group">
            <label>{field}</label>
            {field === "content" ? (
              <textarea
                value={args[field] ?? ""}
                onChange={(e) => setArgs((prev) => ({ ...prev, [field]: e.target.value }))}
                placeholder={field}
                rows={4}
              />
            ) : (
              <input
                value={args[field] ?? ""}
                onChange={(e) => setArgs((prev) => ({ ...prev, [field]: e.target.value }))}
                placeholder={field}
              />
            )}
          </div>
        ))}

        <button onClick={() => void handleRun()} disabled={running}>
          {running ? "执行中…" : "执行"}
        </button>
      </div>

      {lastResult !== undefined && lastResult !== null && (
        <div className="manual-result">
          <div className="message-head">
            <b>最近一次执行结果</b>
            <button className="ghost-btn" onClick={() => void navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2))}>
              复制
            </button>
          </div>
          <pre className="trace-json">{JSON.stringify(lastResult, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
