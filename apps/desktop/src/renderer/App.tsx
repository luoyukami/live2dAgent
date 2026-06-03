import { useEffect, useMemo, useState } from "react"
import type { AgentEvent, AgentMessage, AgentAction } from "@live2d-agent/agent-core"
import { mapEventToState, type AvatarState } from "@live2d-agent/live2d"

interface PublicSettings {
  mode: "manual" | "confirm" | "auto"
  workspaceDir: string
  openaiBaseUrl: string
  openaiModel: string
  hasApiKey: boolean
}

export function App(): JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pending, setPending] = useState<AgentAction[]>([])
  const [status, setStatus] = useState<AvatarState>("idle")
  const [input, setInput] = useState("")
  const [settings, setSettings] = useState<PublicSettings | null>(null)

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
    if (!text) return
    setInput("")
    await window.petAgent.sendUserMessage(text)
  }

  return (
    <main className="shell">
      <section className="avatar" data-state={status}>
        <div className="drag-region" />
        <div className="avatar-orb">Live2D</div>
        <span>{assistantStateLabel}</span>
      </section>

      <section className="panel">
        <header>
          <div>
            <strong>Pet Agent v0</strong>
            <small>{settings?.hasApiKey ? settings.openaiModel : "请在 settings.json 或环境变量配置 API Key"}</small>
          </div>
          <select
            value={settings?.mode ?? "confirm"}
            onChange={async (event) => {
              const mode = event.target.value as PublicSettings["mode"]
              await window.petAgent.updateSettings({ mode })
              setSettings(settings ? { ...settings, mode } : settings)
            }}
          >
            <option value="manual">manual</option>
            <option value="confirm">confirm</option>
            <option value="auto">auto</option>
          </select>
        </header>

        <div className="messages">
          {messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role}`}>
              <b>{message.role}</b>
              <p>{typeof message.content === "string" ? message.content : JSON.stringify(message.content)}</p>
            </article>
          ))}
        </div>

        {pending.map((action) => (
          <article className="approval" key={action.id}>
            <b>请求权限：{action.tool}</b>
            <code>{JSON.stringify(action.args, null, 2)}</code>
            <div>
              <button onClick={() => window.petAgent.approveAction(action.id)}>允许</button>
              <button onClick={() => window.petAgent.denyAction(action.id, "User denied")}>拒绝</button>
            </div>
          </article>
        ))}

        <footer>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submit() }}
            placeholder="输入消息..."
          />
          <button onClick={() => void submit()}>发送</button>
        </footer>
      </section>
    </main>
  )
}
