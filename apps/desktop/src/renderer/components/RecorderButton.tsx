import type { RecorderStatus } from "../audio/useAudioRecorder"

export interface RecorderButtonProps {
  status: RecorderStatus
  durationMs: number
  disabled?: boolean
  /** Called when the user clicks the button while idle / error. */
  onStart: () => void
  /** Called when the user clicks the button while recording. */
  onStop: () => void
  /** Called when the user clicks "cancel" while recording. */
  onCancel: () => void
  /** Override the default title text. */
  title?: string
}

/**
 * Mic button with recording state UI.
 *
 * - idle / error → single mic button
 * - requesting → disabled "请求中…"
 * - recording → pulsing red dot + duration + stop / cancel buttons
 * - finishing → disabled "处理中…"
 *
 * Duration is formatted as m:ss.
 */

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function RecorderButton(props: RecorderButtonProps): JSX.Element {
  const { status, durationMs, disabled, onStart, onStop, onCancel, title } = props

  // Requesting / finishing states
  if (status === "requesting") {
    return (
      <button
        className="icon-btn"
        disabled
        title={title ?? "录音"}
        style={{ fontSize: 14, opacity: 0.6, cursor: "not-allowed" }}
      >
        请求中…
      </button>
    )
  }

  if (status === "finishing") {
    return (
      <button
        className="icon-btn"
        disabled
        title={title ?? "录音"}
        style={{ fontSize: 14, opacity: 0.6, cursor: "not-allowed" }}
      >
        处理中…
      </button>
    )
  }

  // Recording state
  if (status === "recording") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Pulsing red dot */}
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#ef4444",
            flexShrink: 0,
            animation: "pulse 1s infinite",
          }}
        />
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
          }
        `}</style>
        <span
          style={{
            fontSize: 13,
            fontVariantNumeric: "tabular-nums",
            color: "#e2e8f0",
            minWidth: 36,
          }}
        >
          {formatDuration(durationMs)}
        </span>
        <button
          className="ghost-btn"
          onClick={onStop}
          title="停止录音"
          style={{ fontSize: 12, padding: "3px 8px" }}
        >
          停止
        </button>
        <button
          className="ghost-btn danger"
          onClick={onCancel}
          title="取消录音"
          style={{ fontSize: 12, padding: "3px 8px" }}
        >
          取消
        </button>
      </div>
    )
  }

  // Idle / error — mic button
  return (
    <button
      className="icon-btn"
      onClick={onStart}
      disabled={disabled}
      title={title ?? "开始录音"}
      style={{ fontSize: 14 }}
    >
      🎙
    </button>
  )
}
