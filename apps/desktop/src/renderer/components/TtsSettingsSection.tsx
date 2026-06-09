import { useState } from "react"
import type { PublicSettings } from "@live2d-agent/shared"
import type { SettingsForm } from "../renderer-shared"

interface TtsSettingsSectionProps {
  form: SettingsForm
  setForm: React.Dispatch<React.SetStateAction<SettingsForm>>
  settings: PublicSettings | null
}

export function TtsSettingsSection({ form, setForm, settings }: TtsSettingsSectionProps): JSX.Element {
  const [connectionStatus, setConnectionStatus] = useState<"unknown" | "checking" | "ok" | "error">("unknown")
  const [voices, setVoices] = useState<Array<{ voiceId: string; promptText?: string }>>([])
  const [testError, setTestError] = useState<string | null>(null)
  const [registerForm, setRegisterForm] = useState({ voiceId: "", displayName: "", promptText: "" })
  const [promptWavPath, setPromptWavPath] = useState("")
  const [operationStatus, setOperationStatus] = useState<string | null>(null)
  const [voiceIdError, setVoiceIdError] = useState<string | null>(null)

  function validateVoiceId(value: string): string | null {
    if (!value) return "voice_id 必填"
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) return "只能包含字母、数字、下划线、短横线"
    if (value.length > 64) return "长度不能超过 64 个字符"
    return null
  }

  async function handleTestConnection(): Promise<void> {
    setConnectionStatus("checking")
    setTestError(null)
    try {
      // Temporarily update settings to test the current form URL
      const previousUrl = settings?.tts?.apiBaseUrl
      if (form.tts.apiBaseUrl !== previousUrl) {
        await window.petAgent.ttsUpdateSettings({ apiBaseUrl: form.tts.apiBaseUrl })
      }
      const result = await window.petAgent.ttsHealthCheck()
      setConnectionStatus(result.ok ? "ok" : "error")
      if (!result.ok) setTestError(result.error ?? "连接失败")
      // Restore previous URL if test failed and we had temporarily changed it
      if (!result.ok && form.tts.apiBaseUrl !== previousUrl && previousUrl !== undefined) {
        await window.petAgent.ttsUpdateSettings({ apiBaseUrl: previousUrl })
      }
    } catch (err) {
      setConnectionStatus("error")
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRefreshVoices(): Promise<void> {
    setOperationStatus(null)
    try {
      const result = await window.petAgent.ttsListVoices()
      setVoices(result.voices)
    } catch (err) {
      setOperationStatus("获取音色列表失败: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleRegisterVoice(): Promise<void> {
    if (!registerForm.voiceId || !registerForm.promptText || !promptWavPath) return
    const existing = voices.find((v) => v.voiceId === registerForm.voiceId)
    let overwrite = false
    if (existing) {
      const confirmed = window.confirm(`该音色 ID "${registerForm.voiceId}" 已存在，是否覆盖？`)
      if (!confirmed) return
      overwrite = true
    }
    setOperationStatus(null)
    try {
      const result = await window.petAgent.ttsRegisterVoice({
        voiceId: registerForm.voiceId,
        displayName: registerForm.displayName,
        promptText: registerForm.promptText,
        promptWavPath,
        overwrite,
      })
      if (result.ok) {
        setOperationStatus("注册成功")
        const newVoiceId = result.voiceId ?? registerForm.voiceId
        setRegisterForm({ voiceId: "", displayName: "", promptText: "" })
        setPromptWavPath("")
        setVoiceIdError(null)
        // Auto-select the newly registered voice
        if (newVoiceId) {
          setForm((f) => ({
            ...f,
            tts: {
              ...f.tts,
              selectedVoiceId: newVoiceId,
              voiceDisplayNames: {
                ...f.tts.voiceDisplayNames,
                [newVoiceId]: registerForm.displayName || newVoiceId,
              },
            },
          }))
        }
        await handleRefreshVoices()
      } else {
        setOperationStatus("注册失败: " + (result.error ?? "未知错误"))
      }
    } catch (err) {
      setOperationStatus("注册失败: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleDeleteVoice(voiceId: string): Promise<void> {
    const confirmed = window.confirm(`确定要删除音色 "${voiceId}" 吗？`)
    if (!confirmed) return
    setOperationStatus(null)
    try {
      const result = await window.petAgent.ttsDeleteVoice(voiceId)
      if (result.ok) {
        setOperationStatus("已删除")
        if (form.tts.selectedVoiceId === voiceId) {
          setForm((f) => ({ ...f, tts: { ...f.tts, selectedVoiceId: "" } }))
          setOperationStatus("已删除。当前音色已被清空，请重新选择。")
        }
        await handleRefreshVoices()
      } else {
        setOperationStatus("删除失败: " + (result.error ?? "未知错误"))
      }
    } catch (err) {
      setOperationStatus("删除失败: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleRenameDisplayName(voiceId: string): Promise<void> {
    const currentName = form.tts.voiceDisplayNames[voiceId] ?? voiceId
    const newName = prompt(`修改显示名（本地）`, currentName)
    if (!newName || newName === currentName) return
    setForm((f) => ({
      ...f,
      tts: { ...f.tts, voiceDisplayNames: { ...f.tts.voiceDisplayNames, [voiceId]: newName } },
    }))
    setOperationStatus("显示名已更新，保存设置后生效")
  }

  async function handleChangeVoiceId(voiceId: string): Promise<void> {
    const newVoiceId = prompt(`修改音色 ID（服务端操作）`, voiceId)
    if (!newVoiceId || newVoiceId === voiceId) return
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(newVoiceId)) {
      setOperationStatus("音色 ID 只能包含字母、数字、下划线、短横线，长度 1-64")
      return
    }
    setOperationStatus(null)
    try {
      const result = await window.petAgent.ttsRenameVoice(voiceId, newVoiceId)
      if (result.ok) {
        // Migrate local display name
        const newDisplayNames = { ...form.tts.voiceDisplayNames }
        if (newDisplayNames[voiceId]) {
          newDisplayNames[newVoiceId] = newDisplayNames[voiceId]
          delete newDisplayNames[voiceId]
        }
        // Update selected voice if it was the renamed one
        let selectedVoiceId = form.tts.selectedVoiceId
        if (selectedVoiceId === voiceId) {
          selectedVoiceId = newVoiceId
        }
        setForm((f) => ({
          ...f,
          tts: {
            ...f.tts,
            selectedVoiceId,
            voiceDisplayNames: newDisplayNames,
          },
        }))
        await handleRefreshVoices()
      } else {
        setOperationStatus("修改音色 ID 失败: " + (result.error ?? "未知错误"))
      }
    } catch (err) {
      setOperationStatus("修改音色 ID 失败: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleSelectPromptWav(): Promise<void> {
    try {
      const result = await window.petAgent.ttsSelectPromptWav()
      if (result) setPromptWavPath(result)
    } catch {
      // ignore
    }
  }

  async function handleSelectAudioDir(): Promise<void> {
    try {
      const result = await window.petAgent.ttsSelectAudioDir()
      if (result) {
        setForm((f) => ({ ...f, tts: { ...f.tts, audioOutputDir: result } }))
      }
    } catch {
      // ignore
    }
  }

  return (
    <>
      <div className="settings-card">
        <h3 className="settings-card-title">本地 TTS</h3>
        <div className="settings-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.tts.enabled}
              onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, enabled: e.target.checked } }))}
            />
            <span>启用本地 TTS</span>
          </label>
          <small className="settings-hint">启用后，助手消息可自动/手动生成语音并播放。</small>
        </div>

        <div className="settings-group">
          <label>API Base URL</label>
          <div className="settings-row">
            <input
              value={form.tts.apiBaseUrl}
              onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, apiBaseUrl: e.target.value } }))}
              placeholder="http://127.0.0.1:50001"
              disabled={!form.tts.enabled}
            />
            <button className="ghost-btn" onClick={() => void handleTestConnection()} disabled={!form.tts.enabled}>
              测试连接
            </button>
            <span className={`badge ${connectionStatus === "ok" ? "ok" : connectionStatus === "error" ? "warn" : ""}`}>
              {connectionStatus === "checking" ? "检测中..." : connectionStatus === "ok" ? "已连接" : connectionStatus === "error" ? "连接失败" : "未检测"}
            </span>
          </div>
          {testError && <small className="settings-hint" style={{ color: "#e74c3c" }}>{testError}</small>}
        </div>

        <div className="settings-group">
          <div className="settings-row">
            <button className="ghost-btn" onClick={() => void handleRefreshVoices()} disabled={!form.tts.enabled || connectionStatus !== "ok"}>
              刷新音色列表
            </button>
          </div>
          {voices.length > 0 && (
            <div className="tts-voice-list">
              {voices.map((v) => {
                const displayName = form.tts.voiceDisplayNames[v.voiceId] ?? v.voiceId
                const isSelected = v.voiceId === form.tts.selectedVoiceId
                return (
                  <div key={v.voiceId} className={`tts-voice-item ${isSelected ? "selected" : ""}`}>
                    <label className="checkbox-label">
                      <input
                        type="radio"
                        name="tts-voice"
                        checked={isSelected}
                        onChange={() => setForm((f) => ({ ...f, tts: { ...f.tts, selectedVoiceId: v.voiceId } }))}
                      />
                      <span>{displayName}{v.promptText ? ` (${v.promptText.slice(0, 20)}...)` : ""}</span>
                    </label>
                    <div className="settings-row" style={{ gap: 4 }}>
                      <button className="ghost-btn" onClick={() => void handleRenameDisplayName(v.voiceId)} title="修改显示名">R</button>
                      <button className="ghost-btn" onClick={() => void handleChangeVoiceId(v.voiceId)} title="修改音色 ID">ID</button>
                      <button className="ghost-btn" onClick={() => void handleDeleteVoice(v.voiceId)} title="删除">X</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="settings-group">
          <label>注册新音色</label>
          <input
            value={registerForm.voiceId}
            onChange={(e) => {
              setRegisterForm((f) => ({ ...f, voiceId: e.target.value }))
              setVoiceIdError(validateVoiceId(e.target.value))
            }}
            placeholder="voice_id (唯一标识)"
            disabled={!form.tts.enabled}
          />
          {voiceIdError && <small style={{ color: "#e74c3c" }}>{voiceIdError}</small>}
          <input
            value={registerForm.displayName}
            onChange={(e) => setRegisterForm((f) => ({ ...f, displayName: e.target.value }))}
            placeholder="显示名称 (可选)"
            disabled={!form.tts.enabled}
          />
          <input
            value={registerForm.promptText}
            onChange={(e) => setRegisterForm((f) => ({ ...f, promptText: e.target.value }))}
            placeholder="参考文本 (prompt_text)"
            disabled={!form.tts.enabled}
          />
          <div className="settings-row">
            <input
              value={promptWavPath}
              readOnly
              placeholder="参考音频 (.wav)"
              disabled={!form.tts.enabled}
            />
            <button className="ghost-btn" onClick={() => void handleSelectPromptWav()} disabled={!form.tts.enabled}>
              选择文件
            </button>
          </div>
          <button
            className="ghost-btn"
            onClick={() => void handleRegisterVoice()}
            disabled={!form.tts.enabled || !registerForm.voiceId || !registerForm.promptText || !promptWavPath || Boolean(voiceIdError)}
          >
            注册
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">TTS 参数</h3>
        <div className="settings-group">
          <label>TTS 模式</label>
          <select
            value={form.tts.ttsMode}
            onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, ttsMode: e.target.value as "standard" | "emotion_enhanced" } }))}
            disabled={!form.tts.enabled}
          >
            <option value="standard">标准 (standard)</option>
            <option value="emotion_enhanced">情绪增强 (emotion_enhanced)</option>
          </select>
          <small className="settings-hint">情绪增强模式需要模型支持 instruct 端点。</small>
        </div>

        <div className="settings-group">
          <label>情绪控制模式</label>
          <select
            value={form.tts.emotionControlMode}
            onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, emotionControlMode: e.target.value as "default_mapping" | "llm_controlled" } }))}
            disabled={!form.tts.enabled}
          >
            <option value="default_mapping">默认映射 (default_mapping)</option>
            <option value="llm_controlled">LLM 控制 (llm_controlled)</option>
          </select>
        </div>

        <div className="settings-grid two-cols">
          <div className="settings-group">
            <label>语速 (speed)</label>
            <input
              type="number"
              step={0.1}
              min={0.5}
              max={2.0}
              value={form.tts.speed}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setForm((f) => ({ ...f, tts: { ...f.tts, speed: n } }))
              }}
              disabled={!form.tts.enabled}
            />
          </div>
          <div className="settings-group">
            <label>随机种子 (seed)</label>
            <input
              type="number"
              step={1}
              value={form.tts.seed}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setForm((f) => ({ ...f, tts: { ...f.tts, seed: n } }))
              }}
              disabled={!form.tts.enabled}
            />
            <small className="settings-hint">-1 表示随机</small>
          </div>
        </div>

        <div className="settings-group">
          <label>音频输出目录</label>
          <div className="settings-row">
            <input
              value={form.tts.audioOutputDir}
              onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, audioOutputDir: e.target.value } }))}
              placeholder="默认为 userData/tts-output"
              disabled={!form.tts.enabled}
            />
            <button className="ghost-btn" onClick={() => void handleSelectAudioDir()} disabled={!form.tts.enabled}>
              选择目录
            </button>
          </div>
        </div>

        <div className="settings-group">
          <label>请求超时 (ms)</label>
          <input
            type="number"
            step={1000}
            min={10000}
            max={600000}
            value={form.tts.requestTimeoutMs}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) setForm((f) => ({ ...f, tts: { ...f.tts, requestTimeoutMs: n } }))
            }}
            disabled={!form.tts.enabled}
          />
        </div>

        <div className="settings-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.tts.autoGenerateOnAssistantMessage}
              onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, autoGenerateOnAssistantMessage: e.target.checked } }))}
              disabled={!form.tts.enabled}
            />
            <span>助手回复后自动生成语音</span>
          </label>
        </div>

        <div className="settings-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.tts.autoPlayAfterGenerate}
              onChange={(e) => setForm((f) => ({ ...f, tts: { ...f.tts, autoPlayAfterGenerate: e.target.checked } }))}
              disabled={!form.tts.enabled || !form.tts.autoGenerateOnAssistantMessage}
            />
            <span>生成后自动播放</span>
          </label>
        </div>
      </div>

      {operationStatus && <div className="settings-hint" style={{ marginTop: 8 }}>{operationStatus}</div>}
    </>
  )
}
