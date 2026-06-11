import { useCallback, useRef, useState } from "react"

export interface TtsPlayerState {
  playingMessageId: string | null
  isPlaying: boolean
}

export interface TtsPlayerControls {
  play: (audioUrl: string, messageId: string, onError?: (messageId: string, error: Error) => void) => Promise<void>
  stop: () => void
  toggle: (audioUrl: string, messageId: string, onError?: (messageId: string, error: Error) => void) => Promise<void>
}

export function useTtsPlayer(): TtsPlayerState & TtsPlayerControls {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const pendingPlaybackEndRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<TtsPlayerState>({
    playingMessageId: null,
    isPlaying: false,
  })

  const cleanup = useCallback(() => {
    if (pendingPlaybackEndRef.current) {
      pendingPlaybackEndRef.current()
      pendingPlaybackEndRef.current = null
    }
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      audioRef.current = null
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
  }, [])

  const play = useCallback(async (audioUrl: string, messageId: string, onError?: (messageId: string, error: Error) => void) => {
    cleanup()

    const audio = new Audio()
    audioRef.current = audio

    if (audioUrl.startsWith("blob:")) {
      blobUrlRef.current = audioUrl
    }

    audio.src = audioUrl
    setState({ playingMessageId: messageId, isPlaying: true })
    try {
      await audio.play()
      await new Promise<void>((resolve, reject) => {
        pendingPlaybackEndRef.current = resolve
        audio.onended = () => {
          setState({ playingMessageId: null, isPlaying: false })
          audioRef.current = null
          pendingPlaybackEndRef.current = null
          if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current)
            blobUrlRef.current = null
          }
          resolve()
        }
        audio.onerror = () => {
          const err = new Error(`Audio playback failed: ${audio.error?.message || "unknown error"}`)
          setState({ playingMessageId: null, isPlaying: false })
          audioRef.current = null
          pendingPlaybackEndRef.current = null
          if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current)
            blobUrlRef.current = null
          }
          onError?.(messageId, err)
          reject(err)
        }
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setState({ playingMessageId: null, isPlaying: false })
      audioRef.current = null
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      onError?.(messageId, error)
      throw error
    }
  }, [cleanup])

  const stop = useCallback(() => {
    cleanup()
    setState({ playingMessageId: null, isPlaying: false })
  }, [cleanup])

  const toggle = useCallback(async (audioUrl: string, messageId: string, onError?: (messageId: string, error: Error) => void) => {
    setState((prev) => {
      if (prev.playingMessageId === messageId && prev.isPlaying) {
        cleanup()
        return { playingMessageId: null, isPlaying: false }
      }
      // Can't await in setState, so we schedule it
      setTimeout(() => play(audioUrl, messageId, onError), 0)
      return prev
    })
  }, [cleanup, play])

  return { ...state, play, stop, toggle }
}
