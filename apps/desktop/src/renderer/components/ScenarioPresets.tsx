import type { AgentEvent } from "@live2d-agent/agent-core"

export interface Preset {
  label: string
  text: string
}

export const PRESETS: Preset[] = [
  { label: "普通聊天", text: "你好，请介绍一下自己" },
  { label: "看屏幕", text: "请帮我看看当前屏幕" },
  { label: "读取 README", text: "请读取 README.md 并总结内容" },
  { label: "运行 typecheck", text: "请运行 typecheck 并报告结果" },
  { label: "读取剪贴板", text: "请读取剪贴板内容" },
  { label: "写入剪贴板", text: '请将以下内容写入剪贴板：Hello World' },
  { label: "创建文件", text: "请在 workspace 下创建一个 hello.txt，内容为 hello" },
  { label: "权限拒绝测试", text: "请尝试执行一个高风险操作（如删除所有文件）" },
  { label: "task.finish 测试", text: "请结束当前任务" },
]

interface Props {
  onFill: (text: string) => void
  onSend: (text: string) => void
  onClose?: () => void
}

export function ScenarioPresets({ onFill, onSend, onClose }: Props): JSX.Element {
  return (
    <div className="presets-panel">
      <div className="presets-grid">
        {PRESETS.map((preset) => (
          <div key={preset.label} className="preset-card">
            <span className="preset-label">{preset.label}</span>
            <div className="preset-actions">
              <button
                className="ghost-btn"
                onClick={() => {
                  onFill(preset.text)
                  onClose?.()
                }}
              >
                填入
              </button>
              <button
                className="ghost-btn"
                onClick={() => {
                  onSend(preset.text)
                  onClose?.()
                }}
              >
                发送
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
