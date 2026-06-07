import {
  DEFAULT_LIVE2D_EMOTION_PROFILE,
  EMOTION_VALUES,
  resolveEmotionBinding,
  type Emotion,
  type Live2DEmotionProfile,
} from "@live2d-agent/shared"

interface Props {
  activeEmotion: Emotion | null
  profile: Live2DEmotionProfile | undefined
  onSimulate: (emotion: Emotion) => void
  onClear: () => void
  onResetToNeutral: () => void
}

export function EmotionTester({
  activeEmotion,
  profile,
  onSimulate,
  onClear,
  onResetToNeutral,
}: Props): JSX.Element {
  const usingCustom = profile !== undefined && profile !== null
  const effective = profile ?? DEFAULT_LIVE2D_EMOTION_PROFILE

  return (
    <div className="emotion-tester">
      <section className="debug-section">
        <h4>当前 Profile</h4>
        <div className="debug-kv">
          <div>
            <span>来源</span>
            <span>{usingCustom ? "settings.live2d.emotionProfile" : "DEFAULT_LIVE2D_EMOTION_PROFILE"}</span>
          </div>
          <div>
            <span>已注册 emotion</span>
            <span>{Object.keys(effective).length} / {EMOTION_VALUES.length}</span>
          </div>
          <div>
            <span>当前 active</span>
            <span>{activeEmotion ?? "—"}</span>
          </div>
        </div>
        <small className="settings-hint">
          点击下方任一 emotion 等同于把 <code>emotion.set</code> 事件送进 renderer 端，
          会触发 <code>Live2DView</code> 的情绪 effect（resolveEmotionBinding → playMotion / trySetExpression）。
        </small>
      </section>

      <section className="debug-section">
        <h4>模拟 emotion.set</h4>
        <div className="emotion-grid">
          {EMOTION_VALUES.map((emotion) => {
            const binding = resolveEmotionBinding(effective, emotion)
            const isActive = activeEmotion === emotion
            const fellBack = binding !== undefined && effective[emotion] === undefined
            return (
              <div key={emotion} className={`emotion-card ${isActive ? "active" : ""}`}>
                <div className="emotion-card-head">
                  <b>{emotion}</b>
                  {isActive ? <span className="badge ok">active</span> : null}
                  {fellBack ? <span className="badge warn">fallback→neutral</span> : null}
                </div>
                <div className="emotion-binding">
                  {binding ? (
                    <>
                      <div>
                        <span>motion</span>
                        <span>{binding.motion ?? <em className="muted">—</em>}</span>
                      </div>
                      <div>
                        <span>motionIndex</span>
                        <span>{binding.motionIndex ?? <em className="muted">—</em>}</span>
                      </div>
                      <div>
                        <span>expression</span>
                        <span>{binding.expression ?? <em className="muted">—</em>}</span>
                      </div>
                    </>
                  ) : (
                    <small className="settings-hint">无 binding → Live2D 保持现状</small>
                  )}
                </div>
                <div className="emotion-actions">
                  <button className="ghost-btn" onClick={() => onSimulate(emotion)}>
                    触发 emotion.set
                  </button>
                  {isActive ? (
                    <button className="ghost-btn" onClick={onClear}>
                      清除
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="debug-section">
        <h4>操作</h4>
        <div className="debug-actions-row">
          <button className="ghost-btn" onClick={onResetToNeutral}>
            重置为 neutral
          </button>
          <button className="ghost-btn danger" onClick={onClear} disabled={activeEmotion === null}>
            清除 currentEmotion
          </button>
        </div>
        <small className="settings-hint">
          清除后会回到 App.tsx 里的 <code>currentEmotion = null</code> 状态，
          Live2DView 内部 effect 会判定为 &quot;system disabled / no message&quot; 而不切换表情。
        </small>
      </section>
    </div>
  )
}
