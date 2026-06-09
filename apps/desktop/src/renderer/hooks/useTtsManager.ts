import { useCallback, useEffect, useRef, useState } from "react"
import type { LocalTtsSettings, RegisteredVoice, MessageAudioState } from "@live2d-agent/shared"
import { DEFAULT_LOCAL_TTS_SETTINGS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import { useTtsPlayer } from "./useTtsPlayer"

export interface TtsManagerState {
  settings: LocalTtsSettings
  voices: RegisteredVoice[]
  connectionStatus: "unknown" | "checking" | "ok" | "error"
  messageAudioStates: Map<string, MessageAudioState>
}

export interface TtsManagerControls {
  checkConnection: () => Promise<void>
  refreshVoices: () => Promise<void>
  registerVoice: (voiceId: string, displayName: string, promptText: string, promptWavPath: string) => Promise<{ ok: boolean; error?: string }>
  renameVoice: (voiceId: string, displayName: string) => Promise<{ ok: boolean; error?: string }>
  deleteVoice: (voiceId: string) => Promise<{ ok: boolean; error?: string }>
  generateForMessage: (messageId: string, text: string) => Promise<void>
  playMessageAudio: (messageId: string) => void
  stopPlayback: () => void
  retryMessage: (messageId: string, text: string) => Promise<void>
  updateSettings: (patch: Partial<LocalTtsSettings>) => Promise<void>
  selectAudioDir: () => Promise<void>
  handleAgentEvent: (event: AgentEvent) => void
}

export function useTtsManager(): TtsManagerState & TtsManagerControls {
  const [settings, setSettings] = useState<LocalTtsSettings>(DEFAULT_LOCAL_TTS_SETTINGS)
  const [voices, setVoices] = useState<RegisteredVoice[]>([])
  const [connectionStatus, setConnectionStatus] = useState<"unknown" | "checking" | "ok" | "error">("unknown")
  const [messageAudioStates, setMessageAudioStates] = useState<Map<string, MessageAudioState>>(new Map())
  const player = useTtsPlayer()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /* ---- Load settings on mount ---- */
  useEffect(() => {
    void window.petAgent.ttsGetSettings().then((s) => {
      setSettings(s)
    }).catch(() => {
      // use defaults
    })
  }, [])

  /* ---- Periodic health check when enabled ---- */
  useEffect(() => {
    if (settings.enabled) {
      void checkConnection()
    }
    if (pollRef.current) clearInterval(pollRef.current)
    if (settings.enabled) {
      pollRef.current = setInterval(() => {
        void checkConnection()
      }, 30_000)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [settings.enabled])

  /* ---- Stop playback on unmount ---- */
  useEffect(() => {
    return () => player.stop()
  }, [])

  const checkConnection = useCallback(async () => {
    setConnectionStatus("checking")
    try {
      const result = await window.petAgent.ttsHealthCheck()
      setConnectionStatus(result.ok ? "ok" : "error")
    } catch {
      setConnectionStatus("error")
    }
  }, [])

  const refreshVoices = useCallback(async () => {
    try {
      const result = await window.petAgent.ttsListVoices()
      const displayNames = settings.voiceDisplayNames
      const mapped: RegisteredVoice[] = result.voices.map((v) => ({
        voiceId: v.voiceId,
        displayName: displayNames[v.voiceId],
        promptText: v.promptText,
        isSelected: v.voiceId === settings.selectedVoiceId,
      }))
      setVoices(mapped)
    } catch {
      // ignore
    }
  }, [settings.selectedVoiceId, settings.voiceDisplayNames])

  /* Auto-refresh voices on mount and after settings change */
  useEffect(() => {
    if (settings.enabled && connectionStatus === "ok") {
      void refreshVoices()
    }
  }, [settings.enabled, connectionStatus])

  const registerVoice = useCallback(async (
    voiceId: string, displayName: string, promptText: string, promptWavPath: string,
  ) => {
    const result = await window.petAgent.ttsRegisterVoice({
      voiceId,
      displayName,
      promptText,
      promptWavPath,
    })
    if (result.ok) {
      await refreshVoices()
    }
    return result
  }, [refreshVoices])

  const renameVoice = useCallback(async (voiceId: string, displayName: string) => {
    const result = await window.petAgent.ttsRenameVoice(voiceId, displayName)
    if (result.ok) {
      const updatedNames = { ...settings.voiceDisplayNames, [voiceId]: displayName }
      setSettings((prev) => ({ ...prev, voiceDisplayNames: updatedNames }))
      await refreshVoices()
    }
    return result
  }, [settings.voiceDisplayNames, refreshVoices])

  const deleteVoice = useCallback(async (voiceId: string) => {
    const result = await window.petAgent.ttsDeleteVoice(voiceId)
    if (result.ok) {
      if (settings.selectedVoiceId === voiceId) {
        setSettings((prev) => ({ ...prev, selectedVoiceId: undefined }))
      }
      await refreshVoices()
    }
    return result
  }, [settings.selectedVoiceId, refreshVoices])

  const generateForMessage = useCallback(async (messageId: string, text: string) => {
    const voiceId = settings.selectedVoiceId
    if (!voiceId) return

    setMessageAudioStates((prev) => {
      const next = new Map(prev)
      next.set(messageId, { status: "queued", updatedAt: Date.now() })
      return next
    })

    try {
      setMessageAudioStates((prev) => {
        const next = new Map(prev)
        next.set(messageId, { status: "generating", updatedAt: Date.now() })
        return next
      })

      const result = await window.petAgent.ttsGenerate({
        messageId,
        text,
        voiceId,
        mode: settings.ttsMode,
        emotionControlMode: settings.emotionControlMode,
        speed: settings.speed,
        seed: settings.seed,
      })

      if (result.ok && result.audioPath) {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          next.set(messageId, {
            status: "ready",
            currentAudioPath: result.audioPath,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          return next
        })

        if (settings.autoPlayAfterGenerate) {
          player.play(result.audioPath, messageId)
          setMessageAudioStates((prev) => {
            const next = new Map(prev)
            const existing = next.get(messageId)
            if (existing) {
              next.set(messageId, { ...existing, status: "playing" })
            }
            return next
          })
        }
      } else {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          next.set(messageId, {
            status: "error",
            lastError: result.error ?? "生成失败",
            updatedAt: Date.now(),
          })
          return next
        })
      }
    } catch (err) {
      setMessageAudioStates((prev) => {
        const next = new Map(prev)
        next.set(messageId, {
          status: "error",
          lastError: err instanceof Error ? err.message : String(err),
          updatedAt: Date.now(),
        })
        return next
      })
    }
  }, [settings.selectedVoiceId, settings.ttsMode, settings.emotionControlMode, settings.speed, settings.seed, settings.autoPlayAfterGenerate, player])

  const playMessageAudio = useCallback((messageId: string) => {
    const audioState = messageAudioStates.get(messageId)
    if (!audioState?.currentAudioPath) return

    player.play(audioState.currentAudioPath, messageId)
    setMessageAudioStates((prev) => {
      const next = new Map(prev)
      next.set(messageId, { ...audioState, status: "playing" })
      return next
    })
  }, [messageAudioStates, player])

  const stopPlayback = useCallback(() => {
    player.stop()
    setMessageAudioStates((prev) => {
      const next = new Map(prev)
      for (const [id, state] of prev) {
        if (state.status === "playing") {
          next.set(id, { ...state, status: "ready" })
        }
      }
      return next
    })
  }, [player])

  const retryMessage = useCallback(async (messageId: string, text: string) => {
    player.stop()
    setMessageAudioStates((prev) => {
      const next = new Map(prev)
      next.set(messageId, { status: "none" })
      return next
    })
    await generateForMessage(messageId, text)
  }, [player, generateForMessage])

  const updateSettings = useCallback(async (patch: Partial<LocalTtsSettings>) => {
    await window.petAgent.ttsUpdateSettings(patch)
    const updated = await window.petAgent.ttsGetSettings()
    setSettings(updated)
  }, [])

  const selectAudioDir = useCallback(async () => {
    const dir = await window.petAgent.ttsSelectAudioDir()
    if (dir) {
      await updateSettings({ audioOutputDir: dir })
    }
  }, [updateSettings])

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "tts.generating": {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          next.set(event.messageId, { status: "generating", updatedAt: Date.now() })
          return next
        })
        break
      }
      case "tts.ready": {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          next.set(event.messageId, {
            status: "ready",
            currentAudioPath: event.audioPath,
            updatedAt: Date.now(),
          })
          return next
        })
        // Auto-play if enabled
        if (settings.autoPlayAfterGenerate) {
          player.play(event.audioPath, event.messageId)
        }
        break
      }
      case "tts.error": {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          next.set(event.messageId, {
            status: "error",
            lastError: event.error,
            updatedAt: Date.now(),
          })
          return next
        })
        break
      }
      case "tts.playing": {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          const existing = next.get(event.messageId)
          if (existing) {
            next.set(event.messageId, { ...existing, status: "playing" })
          }
          return next
        })
        break
      }
      case "tts.stopped": {
        setMessageAudioStates((prev) => {
          const next = new Map(prev)
          const existing = next.get(event.messageId)
          if (existing && existing.status === "playing") {
            next.set(event.messageId, { ...existing, status: "ready" })
          }
          return next
        })
        break
      }
    }
  }, [settings.autoPlayAfterGenerate, player])

  /* Sync player state back into messageAudioStates */
  useEffect(() => {
    if (!player.playingMessageId) {
      setMessageAudioStates((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [id, state] of prev) {
          if (state.status === "playing") {
            next.set(id, { ...state, status: "ready" })
            changed = true
          }
        }
        return changed ? next : prev
      })
    } else {
      setMessageAudioStates((prev) => {
        const next = new Map(prev)
        const state = next.get(player.playingMessageId!)
        if (state && state.status !== "playing") {
          next.set(player.playingMessageId!, { ...state, status: "playing" })
          return next
        }
        return prev
      })
    }
  }, [player.playingMessageId])

  return {
    settings,
    voices,
    connectionStatus,
    messageAudioStates,
    checkConnection,
    refreshVoices,
    registerVoice,
    renameVoice,
    deleteVoice,
    generateForMessage,
    playMessageAudio,
    stopPlayback,
    retryMessage,
    updateSettings,
    selectAudioDir,
    handleAgentEvent,
  }
}
