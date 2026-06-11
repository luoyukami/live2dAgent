import { useEffect, useMemo, useRef, useState } from "react"
import type { AgentEvent, AgentMessage } from "@live2d-agent/agent-core"
import { mapEventToState, type AvatarState } from "@live2d-agent/live2d"
import type { Emotion, Live2DEmotionProfile, PublicSettings } from "@live2d-agent/shared"
import { Live2DView, type Live2DViewHandle } from "./live2d/Live2DView"
import {
  EMOTION_IDLE_REVERT_MS,
  IDLE_EMOTION,
  hasVisibleText,
  messageContentToText,
  summarize,
  mergeAddedMessage,
} from "./renderer-shared"

/* ------------------------------------------------------------------ */
/*  Platform detection for hit-region strategy                         */
/* ------------------------------------------------------------------ */

function isDarwin(): boolean {
  return /macintosh|mac os x|mac os/i.test(navigator.userAgent)
}

/* ------------------------------------------------------------------ */
/*  AvatarApp — Live2D‑only window root component                      */
/* ------------------------------------------------------------------ */

export function AvatarApp(): JSX.Element {
  const LONG_PRESS_MS = 300
  const MOVE_CANCEL_PX = 8

  const [status, setStatus] = useState<AvatarState>("idle")
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [currentEmotion, setCurrentEmotion] = useState<Emotion | null>(null)
  const [compactAssistantBubbleVisible, setCompactAssistantBubbleVisible] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [live2dReloadKey, setLive2dReloadKey] = useState(0)

  const live2dRef = useRef<Live2DViewHandle>(null)
  const pointerStateRef = useRef<{ pointerId: number; startX: number; startY: number; dragging: boolean; cancelled: boolean; timer: number } | null>(null)
  const passthroughRef = useRef<boolean | null>(null)

  /* ---- 1. Subscribe to agent events once ---- */
  useEffect(() => {
    window.petAgent.getSettings().then(setSettings)
    return window.petAgent.onAgentEvent((event: AgentEvent) => {
      const nextState = mapEventToState(event)
      if (nextState) setStatus(nextState)

      if (event.type === "message.created") {
        setMessages((items) => {
          if (items.some((m) => m.id === event.message.id)) return items
          return [...items, {
            id: event.message.id,
            role: event.message.role,
            content: event.message.content ?? "",
            createdAt: event.message.createdAt,
          } satisfies AgentMessage]
        })
      }
      if (event.type === "message.delta") {
        setMessages((items) => items.map((m) =>
          m.id === event.messageId
            ? { ...m, content: m.content + event.delta }
            : m,
        ))
      }
      if (event.type === "message.added") {
        setMessages((items) => mergeAddedMessage(items, event.message))
      }
      if (event.type === "emotion.set") {
        setCurrentEmotion(event.emotion)
      }
    })
  }, [])

  /* ---- 1b. Subscribe to settings:updated broadcast ---- */
  useEffect(() => {
    return window.petAgent.onSettingsUpdated?.((updated) => {
      setSettings(updated)
    })
  }, [])

  /* ---- Dynamic mouse passthrough / hit-region reporting for avatar window ---- */
  useEffect(() => {
    // Default: enable passthrough
    setAvatarPassthrough(true)

    if (isDarwin()) {
      // macOS: keep the original dynamic mousemove passthrough strategy
      function handleMouseMove(e: MouseEvent): void {
        const isOverInteractiveTarget = live2dRef.current?.containsPoint(e.clientX, e.clientY) ?? false
        setAvatarPassthrough(!isOverInteractiveTarget)
      }
      window.addEventListener("mousemove", handleMouseMove)
      return () => window.removeEventListener("mousemove", handleMouseMove)
    }

    // Non-macOS: no dynamic mousemove toggling; report hit regions instead
    // Initial report
    reportHitRegions()

    // Periodic re-report is only a safety net; Live2DView actively reports
    // after model load/recenter/resize so the shape does not stay stale.
    const intervalId = window.setInterval(() => reportHitRegions(), 2000)
    return () => clearInterval(intervalId)
  }, [])

  /* ---- 1c. Subscribe to live2d:reloaded broadcast ---- */
  useEffect(() => {
    return window.petAgent.onLive2DReloaded?.(() => {
      setLive2dReloadKey((k) => k + 1)
    })
  }, [])

  /* ---- 1d. Re-report hit regions on window resize (non-macOS) ---- */
  useEffect(() => {
    if (isDarwin()) return
    const onResize = () => reportHitRegions()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  /* ---- 1e. Re-report hit regions after model reload (non-macOS) ---- */
  useEffect(() => {
    if (isDarwin()) return
    // Small delay to let model render a frame before reading bounds
    const timer = setTimeout(() => reportHitRegions(), 300)
    return () => clearTimeout(timer)
  }, [live2dReloadKey])

  /* ---- 2. Derive latest assistant text for speech bubble ---- */
  const latestAssistantMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant" && hasVisibleText(message)),
    [messages],
  )
  const latestAssistantText = latestAssistantMessage
    ? messageContentToText(latestAssistantMessage).trim()
    : ""

  /* ---- 3. Show speech bubble on new assistant text, auto-hide after 20s ---- */
  useEffect(() => {
    if (!latestAssistantMessage || latestAssistantText.length === 0) {
      setCompactAssistantBubbleVisible(false)
      return
    }

    setCompactAssistantBubbleVisible(true)
    const timer = window.setTimeout(() => setCompactAssistantBubbleVisible(false), 20_000)
    return () => window.clearTimeout(timer)
  }, [latestAssistantMessage?.id, latestAssistantText])

  /* ---- 4. Auto-revert transient status to idle ---- */
  useEffect(() => {
    if (status === "success") {
      const timer = setTimeout(() => setStatus("idle"), 1500)
      return () => clearTimeout(timer)
    }
    if (status === "error") {
      const timer = setTimeout(() => setStatus("idle"), 2000)
      return () => clearTimeout(timer)
    }
  }, [status])

  /* ---- 5. Emotion fallback to default after inactivity ---- */
  useEffect(() => {
    if (settings?.emotion?.enabled === false) return
    const defaultEmotion = settings?.emotion?.defaultEmotion ?? IDLE_EMOTION
    if (currentEmotion === null || currentEmotion === defaultEmotion) return

    const timer = setTimeout(() => {
      setCurrentEmotion(defaultEmotion)
    }, EMOTION_IDLE_REVERT_MS)

    return () => clearTimeout(timer)
  }, [currentEmotion, settings?.emotion?.defaultEmotion, settings?.emotion?.enabled])

  /* ---- 6. Emotion system disabled → clear emotion ---- */
  useEffect(() => {
    if (settings && settings.emotion && !settings.emotion.enabled) {
      setCurrentEmotion(null)
    }
  }, [settings?.emotion?.enabled])

  /* ---- 7. Render: only Live2D stage + speech bubble ---- */

  function reportHitRegions(): void {
    const rects = live2dRef.current?.getInteractiveRects() ?? []
    void window.petAgent.setAvatarHitRegion?.(rects)
  }

  function setAvatarPassthrough(next: boolean): void {
    if (passthroughRef.current === next) return
    passthroughRef.current = next
    void window.petAgent.setMousePassthrough?.(next, "avatar")
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    if (!(live2dRef.current?.containsPoint(event.clientX, event.clientY) ?? false)) return
    const state = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      dragging: false,
      cancelled: false,
      timer: window.setTimeout(() => {
        const current = pointerStateRef.current
        if (!current || current.pointerId !== event.pointerId || current.cancelled) return
        current.dragging = true
        void window.petAgent.hideUiWindow?.()
        void window.petAgent.setMousePassthrough?.(false, "avatar")
        void window.petAgent.startWindowDrag?.("avatar")
      }, LONG_PRESS_MS),
    }
    pointerStateRef.current = state
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleStagePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const state = pointerStateRef.current
    if (!state || state.pointerId !== event.pointerId || state.dragging) return
    const moved = Math.hypot(event.screenX - state.startX, event.screenY - state.startY)
    if (moved > MOVE_CANCEL_PX) {
      state.cancelled = true
      window.clearTimeout(state.timer)
    }
  }

  function finishPointer(event: React.PointerEvent<HTMLDivElement>): void {
    const state = pointerStateRef.current
    if (!state || state.pointerId !== event.pointerId) return
    window.clearTimeout(state.timer)
    pointerStateRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch { /* ignore */ }
    if (state.dragging) {
      void window.petAgent.endWindowDrag?.("avatar")
      return
    }
    if (!state.cancelled) {
      void window.petAgent.companionActivity?.({ source: "user" })
      void window.petAgent.showCompactInput?.({ screenX: event.screenX, screenY: event.screenY })
    }
  }

  return (
    <main className="shell">
      <section className="stage" data-state={status}>
        <div
          className="stage-content"
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
          onLostPointerCapture={finishPointer}
        >
          <Live2DView
            ref={live2dRef}
            key={live2dReloadKey}
            modelPath={settings?.live2d?.modelPath ?? ""}
            avatarState={status}
            emotion={currentEmotion}
            emotionProfile={settings?.live2d?.emotionProfile}
            onInteractiveRectsChanged={isDarwin() ? undefined : (rects) => {
              void window.petAgent.setAvatarHitRegion?.(rects)
            }}
          />
          {compactAssistantBubbleVisible && latestAssistantText && (
            <div className="assistant-speech-bubble" aria-live="polite">
              {summarize(latestAssistantText, 220)}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}
