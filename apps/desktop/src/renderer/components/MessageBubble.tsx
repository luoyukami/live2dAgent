import { useState } from "react"
import type { AgentMessage } from "@live2d-agent/agent-core"
import type { MessageAudioState } from "@live2d-agent/shared"
import { AudioAttachmentCard } from "./AudioAttachmentCard"
import { messageContentToText, summarize } from "../renderer-shared"

interface MessageBubbleProps {
  message: AgentMessage
  messageAudioState?: MessageAudioState
  onGenerateTts?: (messageId: string) => void
  onPlayTts?: (messageId: string) => void
  onStopTts?: () => void
  onRetryTts?: (messageId: string) => void
}

function sanitizeDisplayText(raw: string): string {
  // Remove trailing emotion tags
  let cleaned = raw.replace(/(?:\r?\n)?[ \t]*<emotion\s+value\s*=\s*["']([a-z_]+)["']\s*\/>[ \t]*(?:\r?\n)?[ \t]*$/gi, "")
  // Remove TTS instruction tags (all occurrences)
  cleaned = cleaned.replace(/\[\[TTS_INSTRUCTION:[\s\S]*?\]\]/g, "")
  // Trim extra blank lines
  cleaned = cleaned.replace(/(?:[ \t]*\r?\n)+[ \t]*$/u, "").replace(/[ \t]+$/u, "")
  return cleaned.trim()
}

export function MessageBubble({
  message,
  messageAudioState,
  onGenerateTts,
  onPlayTts,
  onStopTts,
  onRetryTts,
}: MessageBubbleProps): JSX.Element {
  const [expanded, setExpanded] = useState(message.role !== "tool")
  const text = messageContentToText(message)
  const displayText = sanitizeDisplayText(text)
  const isError = Boolean(message.extra?.error) || /^(API error|Network error|Invalid JSON|Model returned|Error executing)/i.test(text)
  const audioAttachments = (message.attachments ?? []).filter((a) => a.type === "audio")

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(displayText)
  }

  const ttsStatus = messageAudioState?.status ?? "none"

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
      {expanded ? <p>{displayText}</p> : <p className="tool-summary">{summarize(displayText, 160)}</p>}
      {message.role === "assistant" && onGenerateTts && (
        <div className="message-tts-controls">
          {ttsStatus === "none" && (
            <button className="ghost-btn tts-btn" onClick={() => onGenerateTts(message.id)}>
              生成语音
            </button>
          )}
          {(ttsStatus === "queued" || ttsStatus === "generating") && (
            <span className="tts-loading">生成中...</span>
          )}
          {ttsStatus === "ready" && (
            <>
              <button className="ghost-btn tts-btn" onClick={() => onPlayTts?.(message.id)}>
                播放
              </button>
              <button className="ghost-btn tts-btn" onClick={() => onRetryTts?.(message.id)}>
                重新生成
              </button>
            </>
          )}
          {ttsStatus === "playing" && (
            <>
              <button className="ghost-btn tts-btn" onClick={() => onStopTts?.()}>
                停止
              </button>
              <button className="ghost-btn tts-btn" onClick={() => onRetryTts?.(message.id)}>
                重新生成
              </button>
            </>
          )}
          {ttsStatus === "error" && (
            <>
              <button className="ghost-btn tts-btn" onClick={() => onRetryTts?.(message.id)}>
                重试
              </button>
              {messageAudioState?.lastError && (
                <span className="tts-error" title={messageAudioState.lastError}>错误</span>
              )}
            </>
          )}
        </div>
      )}
    </article>
  )
}
