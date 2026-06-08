import type { AgentAction } from "@live2d-agent/agent-core"
import { RISK_TEXT, riskForTool, asRecord, renderActionSummary } from "../renderer-shared"

export function ApprovalBubble({ action }: { action: AgentAction }): JSX.Element {
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
