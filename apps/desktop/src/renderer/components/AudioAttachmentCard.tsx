export interface AudioAttachmentCardProps {
  /** A short label, e.g. "录音 12.3s · wav". */
  label: string
  /** Sub-label for the mime type / size, e.g. "audio/wav · 124 KB". */
  subLabel?: string
  /** Optional click handler — opens the audio file in a new Electron window, plays it, etc. */
  onPlay?: () => void
  /** Show a remove button. */
  onRemove?: () => void
  disabled?: boolean
  /** Icon emoji or string to display instead of the default microphone. */
  icon?: string
}

/**
 * Compact card displaying an audio attachment inside the input row or
 * inside a message bubble. Uses inline styles to stay self-contained;
 * can be refactored into styles.css later.
 */
export function AudioAttachmentCard(props: AudioAttachmentCardProps): JSX.Element {
  const { label, subLabel, onPlay, onRemove, disabled, icon } = props

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 10,
        background: "rgba(255,255,255,.10)",
        border: "1px solid rgba(255,255,255,.12)",
        fontSize: 12,
        color: "#e2e8f0",
        lineHeight: 1.3,
      }}
    >
      <span
        style={{
          fontSize: 18,
          flexShrink: 0,
          lineHeight: 1,
        }}
        role="img"
        aria-label="attachment"
      >
        {icon ?? "🎙"}
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        {subLabel && (
          <span style={{ display: "block", color: "#94a3b8", fontSize: 11 }}>
            {subLabel}
          </span>
        )}
      </span>

      {onPlay && (
        <button
          className="ghost-btn"
          onClick={onPlay}
          disabled={disabled}
          title="播放"
          style={{ padding: "3px 7px", fontSize: 12 }}
        >
          ▶
        </button>
      )}

      {onRemove && (
        <button
          className="ghost-btn danger"
          onClick={onRemove}
          disabled={disabled}
          title="移除"
          style={{ padding: "3px 7px", fontSize: 12 }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
