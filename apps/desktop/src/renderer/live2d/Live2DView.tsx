import { useEffect, useRef, useState } from "react"
import * as PIXI from "pixi.js"
import type { AvatarState } from "@live2d-agent/live2d"

declare global {
  interface Window {
    PIXI?: typeof PIXI
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a local filesystem path to a file:// URL.
 * - `http://` / `https://` / `file://` are passed through
 * - Windows absolute paths (`C:\path` or `C:/path`) get `file:///` prefix
 * - Unix absolute paths (`/path`) get `file://` prefix
 */
function toFileUrl(path: string): string {
  if (/^https?:\/\//i.test(path) || path.startsWith("file://")) {
    return path
  }
  // Windows absolute path: C:\path\to\file or C:/path/to/file
  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    return "file:///" + path.replace(/\\/g, "/")
  }
  // Unix absolute path
  if (path.startsWith("/")) {
    return "file://" + path
  }
  return path
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface Live2DViewProps {
  /** Path or URL to a Live2D .model3.json file. */
  modelPath: string
  /** Current avatar state from agent-core events. */
  avatarState: AvatarState
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Live2DView({ modelPath, avatarState }: Live2DViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const modelRef = useRef<InstanceType<any> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /* ---- 1. Create / destroy the Pixi Application ---- */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const app = new PIXI.Application({
      resizeTo: container,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    container.appendChild(app.view as HTMLCanvasElement)
    appRef.current = app

    return () => {
      destroyModel()
      app.destroy(true, { children: true })
      appRef.current = null
    }
  }, [])

  /* ---- 2. Load / unload model when modelPath changes ---- */
  useEffect(() => {
    if (!appRef.current) return

    destroyModel()
    setLoadError(null)

    if (!modelPath) {
      setLoadError("可在设置中配置 Live2D 模型路径")
      return
    }

    loadModel(modelPath).catch(() => {
      /* error already handled inside loadModel */
    })
  }, [modelPath])

  /* ---- 3. React to avatar state changes ---- */
  useEffect(() => {
    const model = modelRef.current
    if (!model) return

    switch (avatarState) {
      case "idle":
        playMotion(model, "idle")
        trySetExpression(model, "idle")
        break
      case "thinking":
        playMotion(model, "thinking")
        trySetExpression(model, "thinking")
        break
      case "waiting_approval":
        playMotion(model, "waiting_approval")
        trySetExpression(model, "waiting_approval")
        break
      case "running_tool":
        playMotion(model, "running_tool")
        trySetExpression(model, "running_tool")
        break
      case "success":
        playMotion(model, "tap_body")
        trySetExpression(model, "success")
        break
      case "error":
        playMotion(model, "tap_body")
        trySetExpression(model, "error")
        break
    }
  }, [avatarState])

  /* ---- Internal helpers ---- */

  async function loadModel(path: string): Promise<void> {
    try {
      window.PIXI = PIXI
      const { Live2DModel } = await import("pixi-live2d-display-lipsyncpatch")
      const url = toFileUrl(path)
      const model = await Live2DModel.from(url)

      modelRef.current = model
      appRef.current!.stage.addChild(model)

      centerModel(model)
      setLoadError(null)
    } catch (err) {
      setLoadError("Live2D 加载失败，使用 fallback")
      console.error("[Live2DView] Failed to load model:", err)
    }
  }

  function centerModel(model: InstanceType<any>): void {
    const app = appRef.current
    const container = containerRef.current
    if (!app || !container) return

    const cw = container.clientWidth || 300
    const ch = container.clientHeight || 300
    const mw = model.width || 1
    const mh = model.height || 1

    const scale = Math.min(cw / mw, ch / mh) * 0.8
    model.scale.set(scale)
    model.position.set(app.screen.width / 2, app.screen.height / 2)

    if (typeof model.anchor?.set === "function") {
      model.anchor.set(0.5, 0.5)
    }
  }

  function destroyModel(): void {
    if (modelRef.current) {
      try {
        appRef.current?.stage.removeChild(modelRef.current)
        modelRef.current.destroy()
      } catch {
        /* ignore cleanup errors */
      }
      modelRef.current = null
    }
  }

  function playMotion(model: InstanceType<any>, group: string): void {
    try {
      model.motion?.(group)
    } catch {
      /* silently fail – model may not have this motion */
    }
  }

  function trySetExpression(model: InstanceType<any>, name: string): void {
    try {
      model.expression?.(name)
    } catch {
      /* silently fail – model may not have this expression */
    }
  }

  /* ---- Render ---- */

  const showFallback = !modelPath || loadError !== null
  const fallbackClass = loadError ? "avatar-orb fallback-error" : "avatar-orb fallback-empty"

  return (
    <div className="live2d-container" ref={containerRef}>
      {showFallback && <div className={fallbackClass}>{loadError || "Live2D"}</div>}
    </div>
  )
}
