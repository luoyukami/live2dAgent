import { useMemo, useState } from "react"
import type { AgentEvent } from "@live2d-agent/agent-core"

interface Props {
  events: Array<{ ts: number; event: AgentEvent }>
  onOpenFolder: () => void
}

export function TraceViewer({ events, onOpenFolder }: Props): JSX.Element {
  const [filter, setFilter] = useState("")
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  const filtered = useMemo(() => {
    if (!filter.trim()) return events
    const f = filter.trim().toLowerCase()
    return events.filter((e) => {
      const ev = e.event as Record<string, unknown>
      const type = String(ev.type ?? "").toLowerCase()
      return type.includes(f)
    })
  }, [events, filter])

  async function copyJson(obj: unknown): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(obj, null, 2))
  }

  async function copySummary(): Promise<void> {
    const summary = filtered.map((e) => ({ ts: e.ts, event: e.event }))
    await navigator.clipboard.writeText(JSON.stringify(summary, null, 2))
  }

  return (
    <div className="trace-viewer">
      <div className="trace-toolbar">
        <input
          className="trace-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="按 event type 过滤，如 message.added"
        />
        <button className="ghost-btn" onClick={() => void copySummary()}>
          复制 trace 摘要
        </button>
        <button className="ghost-btn" onClick={() => void onOpenFolder()}>
          打开 trace 文件夹
        </button>
      </div>
      <div className="trace-list">
        {filtered.length === 0 && <small>暂无 trace 事件</small>}
        {filtered.map((item, idx) => {
          const ev = item.event as Record<string, unknown>
          const type = String(ev.type ?? "unknown")
          const isOpen = expandedIndex === idx
          return (
            <div key={`${item.ts}-${idx}`} className="trace-item">
              <div className="trace-row" onClick={() => setExpandedIndex(isOpen ? null : idx)}>
                <span className="trace-ts">{new Date(item.ts).toLocaleTimeString()}</span>
                <span className="trace-type">{type}</span>
                <button
                  className="ghost-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    void copyJson(item.event)
                  }}
                >
                  复制 JSON
                </button>
              </div>
              {isOpen && (
                <pre className="trace-json">{JSON.stringify(item.event, null, 2)}</pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
