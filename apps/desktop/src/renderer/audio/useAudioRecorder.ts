/**
 * React hook for microphone recording via Web Audio API.
 *
 * Uses ScriptProcessorNode (deprecated but universally supported) instead of
 * AudioWorklet to avoid CSP and module-loading issues in sandboxed Electron
 * renderers. The trade-off is minor GC pressure from Float32Array copies.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { WavStreamEncoder } from "./wav-encoder"

/* ---- Public types ---- */

export type RecorderStatus = "idle" | "requesting" | "recording" | "finishing" | "error"

export interface RecorderState {
  status: RecorderStatus
  /** ms elapsed since recording started. Updated on each animation frame. */
  durationMs: number
  /** Last error message, if any. */
  error: string | null
  /** True when the browser denied microphone permission or no device is available. */
  permissionDenied: boolean
}

export interface UseAudioRecorderOptions {
  /** Hard cap on recording duration, ms. Recording auto-stops when reached. */
  maxDurationMs?: number
  /**
   * Called when the recorder auto-stops at `maxDurationMs`.
   * Receives the final WAV Blob (or null if no samples were captured).
   * Not invoked on manual `stop()` or `cancel()`.
   */
  onAutoStop?: (blob: Blob | null) => void
}

export interface UseAudioRecorderResult extends RecorderState {
  start: () => Promise<void>
  /** Resolves with the WAV Blob, or null if cancelled / no samples captured. */
  stop: () => Promise<Blob | null>
  cancel: () => void
  isSupported: boolean
}

/* ---- Hook implementation ---- */

/*
 * Note on window.petAgent type augmentation:
 * `env.d.ts` already declares `window.petAgent: PetAgentApi` from preload.
 * The audio-related methods (saveAudioRecording, updateVoiceDebug, openAudioFolder)
 * are not yet on the preload bridge — other agents will add them. When they do,
 * the augmentation in `env.d.ts` will cover them. In the meantime, this hook
 * does NOT call those methods directly; the orchestrator will handle persistence.
 * If you need to call them from here, use:
 *   (window.petAgent as any).saveAudioRecording?.({ ... })
 */

export function useAudioRecorder(
  options?: UseAudioRecorderOptions,
): UseAudioRecorderResult {
  const maxDurationMs = options?.maxDurationMs

  // Keep a ref to the latest options so the rAF tick never captures stale callbacks
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  // Mutable refs for Web Audio objects (not React state — we don't re-render on these)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const encoderRef = useRef<WavStreamEncoder | null>(null)
  const rafRef = useRef<number>(0)
  const startTimeRef = useRef<number>(0)
  const [state, setState] = useState<RecorderState>({
    status: "idle",
    durationMs: 0,
    error: null,
    permissionDenied: false,
  })

  // Stable isSupported check
  const isSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)

  /* ---- cleanup helpers ---- */

  const cleanupAudio = useCallback(() => {
    // Stop animation frame
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    // Stop all media tracks (releases mic indicator)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    // Disconnect processor
    processorRef.current?.disconnect()
    processorRef.current = null
    // Close audio context
    audioCtxRef.current
      ?.close()
      .catch(() => { /* ignore */ })
    audioCtxRef.current = null
  }, [])

  const resetState = useCallback(() => {
    setState({ status: "idle", durationMs: 0, error: null, permissionDenied: false })
  }, [])

  /* ---- finalize recording (shared by stop + auto-stop) ---- */

  /**
   * Finalize the in-progress recording exactly once. Safe to call from
   * either the public `stop()` or the auto-stop handler — calling it a
   * second time returns null. The encoder reference is nulled BEFORE
   * `finalize()` so a concurrent caller sees a clean state.
   */
  const finalizeRecording = useCallback(async (): Promise<Blob | null> => {
    const encoder = encoderRef.current
    encoderRef.current = null
    cleanupAudio()

    if (!encoder || encoder.totalSamples === 0) {
      resetState()
      return null
    }

    const blob = encoder.finalize()
    resetState()
    return blob
  }, [cleanupAudio, resetState])

  /* ---- start ---- */

  // We store the "start work" in a ref so the start() promise can be
  // returned immediately on repeated calls.
  const startPromiseRef = useRef<Promise<void> | null>(null)

  const start = useCallback(async (): Promise<void> => {
    // If already recording, return the existing promise
    if (startPromiseRef.current) return startPromiseRef.current

    const work = (async () => {
      setState((prev) => ({
        ...prev,
        status: "requesting",
        error: null,
        permissionDenied: false,
      }))

      if (!navigator.mediaDevices?.getUserMedia) {
        setState({
          status: "error",
          durationMs: 0,
          error: "当前环境不支持录音",
          permissionDenied: false,
        })
        startPromiseRef.current = null
        return
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        })
      } catch (err: unknown) {
        const name =
          err instanceof DOMException ? err.name : ""
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setState({
            status: "error",
            durationMs: 0,
            error: "麦克风权限被拒绝",
            permissionDenied: true,
          })
        } else if (name === "NotFoundError" || name === "NotReadableError") {
          setState({
            status: "error",
            durationMs: 0,
            error: "未找到可用的麦克风设备",
            permissionDenied: false,
          })
        } else {
          setState({
            status: "error",
            durationMs: 0,
            error: `录音启动失败：${err instanceof Error ? err.message : String(err)}`,
            permissionDenied: false,
          })
        }
        startPromiseRef.current = null
        return
      }

      streamRef.current = stream

      // Create AudioContext with the stream's native sample rate for fidelity
      const ctx = new AudioContext({ sampleRate: stream.getAudioTracks()[0]?.getSettings().sampleRate ?? 48000 })
      audioCtxRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor

      const encoder = new WavStreamEncoder(ctx.sampleRate, 1)
      encoderRef.current = encoder

      // Connect: mic → processor → destination (destination needed to keep processor alive)
      source.connect(processor)
      processor.connect(ctx.destination)

      const startTime = Date.now()
      startTimeRef.current = startTime

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const input = e.inputBuffer.getChannelData(0)
        // Float32Array from ScriptProcessor is reused — must copy
        encoder.push(new Float32Array(input))
      }

      // Animation frame loop for duration display
      const tick = () => {
        const elapsed = Date.now() - startTime
        setState((prev) => ({ ...prev, durationMs: elapsed }))

        if (maxDurationMs && elapsed >= maxDurationMs) {
          // Auto-stop at max duration
          const handleAutoStop = async () => {
            setState((prev) => ({ ...prev, status: "finishing" }))
            if (optionsRef.current?.onAutoStop) {
              const blob = await finalizeRecording()
              optionsRef.current.onAutoStop(blob)
            } else {
              await finalizeRecording()
            }
          }
          void handleAutoStop()
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      setState({ status: "recording", durationMs: 0, error: null, permissionDenied: false })
      startPromiseRef.current = null
    })()

    startPromiseRef.current = work
    return work
  }, [maxDurationMs, cleanupAudio, finalizeRecording])

  /* ---- stop (public) ---- */

  const stop = useCallback(async (): Promise<Blob | null> => {
    if (encoderRef.current === null) return null
    setState((prev) => ({ ...prev, status: "finishing" }))
    return finalizeRecording()
  }, [finalizeRecording])

  /* ---- cancel ---- */

  const cancel = useCallback(() => {
    // Discard the encoder, reset everything
    encoderRef.current = null
    cleanupAudio()
    resetState()
  }, [cleanupAudio, resetState])

  /* ---- cleanup on unmount ---- */

  useEffect(() => {
    return () => {
      encoderRef.current = null
      cleanupAudio()
    }
  }, [cleanupAudio])

  return {
    ...state,
    start,
    stop,
    cancel,
    isSupported,
  }
}
