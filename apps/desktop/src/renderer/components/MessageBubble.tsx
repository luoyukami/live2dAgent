import { useState } from "react"
import type { AgentMessage } from "@live2d-agent/agent-core"
import { AudioAttachmentCard } from "./AudioAttachmentCard"
import { messageContentToText, summarize } from "../renderer-shared"

export function MessageBubble({ message }: { message: AgentMessage }): JSX.Element {
  const [expanded, setExpanded] = useState(message.role !== "tool")
  const text = messageContentToText(message)
  const isError = Boolean(message.extra?.error) || /^(API error|Network error|Invalid JSON|Model returned|Error executing)/i.test(text)
  const audioAttachments = (message.attachments ?? []).filter((a) => a.type === "audio")

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
      {audioAttachments.length > 0 && (
        <div className="message-attachments">
          {audioAttachments.map((att) => (
            <AudioAttachmentCard
              key={att.id}
              label={`录音 ${(att.durationMs / 1000).toFixed(1)}s`}
              subLabel={`${att.mimeType} · ${(att.artifact.size / 1024).toFixed(1)} KB`}
            />
          ))}
        </div>
      )}
      {expanded ? <p>{text}</p> : <p className="tool-summary">{summarize(text, 160)}</p>}
    </article>
  )
}
