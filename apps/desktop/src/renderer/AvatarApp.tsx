import { useEffect, useMemo, useState } from "react"
import type { AgentEvent, AgentMessage } from "@live2d-agent/agent-core"
import { mapEventToState, type AvatarState } from "@live2d-agent/live2d"
import type { Emotion, Live2DEmotionProfile, PublicSettings } from "@live2d-agent/shared"
import { Live2DView, type Live2DViewHandle } from "./live2d/Live2DView"

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const EMOTION_IDLE_REVERT_MS = 20_000
const IDLE_EMOTION: Emotion = "neutral"

/* ------------------------------------------------------------------ */
/*  Helper functions (pure, copied from App.tsx)                       */
/* ------------------------------------------------------------------ */

function hasVisibleText(message: AgentMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0
  return Array.isArray(message.content) && message.content.length > 0
}

function messageContentToText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content.map((block) => {
    if (block.type === "text") return block.text ?? ""
    if (block.type === "image_url") return "[图片输入]"
    if (block.type === "input_audio") return "[音频输入]"
    return JSON.stringify(block)
  }).filter(Boolean).join("\n")
}

function summarize(text: string, max = 240): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function shouldRenderAddedMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") return true
  return hasVisibleText(message)
}

function mergeAddedMessage(items: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const existingIndex = items.findIndex((item) => item.id === message.id)

  if (!shouldRenderAddedMessage(message)) {
    return existingIndex >= 0 ? items.filter((item) => item.id !== message.id) : items
  }

  if (existingIndex < 0) return [...items, message]

  return items.map((item, index) => {
    if (index !== existingIndex) return item
    return {
      ...item,
      ...message,
      content: hasVisibleText(message) ? message.content : item.content,
    }
  })
}

/* ------------------------------------------------------------------ */
/*  AvatarApp — Live2D‑only window root component                      */
/* ------------------------------------------------------------------ */

export function AvatarApp(): JSX.Element {
  const [status, setStatus] = useState<AvatarState>("idle")
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [currentEmotion, setCurrentEmotion] = useState<Emotion | null>(null)
  const [compactAssistantBubbleVisible, setCompactAssistantBubbleVisible] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [live2dReloadKey, setLive2dReloadKey] = useState(0)

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

  /* ---- 1c. Subscribe to live2d:reloaded broadcast ---- */
  useEffect(() => {
    return window.petAgent.onLive2DReloaded?.(() => {
      setLive2dReloadKey((k) => k + 1)
    })
  }, [])

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
  return (
    <main className="shell">
      <section className="stage" data-state={status}>
        <div className="stage-content">
          <Live2DView
            key={live2dReloadKey}
            modelPath={settings?.live2d?.modelPath ?? ""}
            avatarState={status}
            emotion={currentEmotion}
            emotionProfile={settings?.live2d?.emotionProfile}
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
