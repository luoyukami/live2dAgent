import { useCallback, useRef, useState } from "react"

export interface TtsPlayerState {
  playingMessageId: string | null
  isPlaying: boolean
}

export interface TtsPlayerControls {
  play: (audioPath: string, messageId: string) => void
  stop: () => void
  toggle: (audioPath: string, messageId: string) => void
}

export function useTtsPlayer(): TtsPlayerState & TtsPlayerControls {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<TtsPlayerState>({
    playingMessageId: null,
    isPlaying: false,
  })

  const cleanup = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      audioRef.current = null
    }
  }, [])

  const play = useCallback((audioPath: string, messageId: string) => {
    cleanup()

    const audio = new Audio()
    audioRef.current = audio

    audio.src = `file://${audioPath}`
    audio.onended = () => {
      setState({ playingMessageId: null, isPlaying: false })
      audioRef.current = null
    }
    audio.onerror = () => {
      setState({ playingMessageId: null, isPlaying: false })
      audioRef.current = null
    }

    setState({ playingMessageId: messageId, isPlaying: true })
    void audio.play()
  }, [cleanup])

  const stop = useCallback(() => {
    cleanup()
    setState({ playingMessageId: null, isPlaying: false })
  }, [cleanup])

  const toggle = useCallback((audioPath: string, messageId: string) => {
    setState((prev) => {
      if (prev.playingMessageId === messageId && prev.isPlaying) {
        cleanup()
        return { playingMessageId: null, isPlaying: false }
      }
      play(audioPath, messageId)
      return prev
    })
  }, [cleanup, play])

  return { ...state, play, stop, toggle }
}
