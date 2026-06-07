import { useEffect, useRef, useState } from "react"
import * as PIXI from "pixi.js"
import type { AvatarState } from "@live2d-agent/live2d"
import {
  DEFAULT_LIVE2D_EMOTION_PROFILE,
  resolveEmotionBinding,
  type Emotion,
  type Live2DEmotionProfile,
} from "@live2d-agent/shared"

declare global {
  interface Window {
    PIXI?: typeof PIXI
    Live2DCubismCore?: unknown
  }
}

let cubismCorePromise: Promise<void> | null = null
let cubismCoreScript: HTMLScriptElement | null = null

/* ------------------------------------------------------------------ */
/*  Model-specific load quirks                                         */
/* ------------------------------------------------------------------ */

/**
 * 某些 Live2D 模型（多为 VTuber 社区二次配布的 model）会在加载时自带一个
 * 提示/水印 overlay，需要手动激活一次特定 .exp3.json 才能关掉。
 *
 * 为了不污染 Agent Core（详见 AGENTS.md "Live2D 开发约定"），我们把这类
 * "加载即触发一次" 的表情规则集中维护在 renderer 侧的一张表里。
 *
 * 匹配方式：按 model3.json 的 basename 精确匹配（避免目录名 / 绝对路径
 * 差异导致漏匹配）。命中后会在模型加载完成、首次渲染前自动调用一次
 * model.expression(name)，让用户看到的第一帧就是"干净"状态。
 *
 * 新增规则：
 *   1. 把 .exp3.json 放到模型目录里；
 *   2. 在 MODEL_LOAD_QUIRKS 里追加一条 { modelFile, expression }；
 *   3. 跑一次 `corepack pnpm typecheck` 确认引用闭合。
 *
 * 注意：这里的 expression 名称来自 .exp3.json 的文件名（不含扩展名），
 * 与 Live2D ModelSettings.Expressions 列表的 Name 字段保持一致。
 */
const MODEL_LOAD_QUIRKS: ReadonlyArray<{
  /** model3.json 的文件名（含 .model3.json 后缀），按 basename 匹配。 */
  modelFile: string
  /** 加载完成后自动触发一次的表情名（对应 .exp3.json 的文件名）。 */
  expression: string
}> = [
  {
    // 玳瑁猫 v1（VTS 版本）默认带一个 Param6 控制的内置提示层，
    // 必须激活 `关闭提示.exp3.json`（Param6=1.0, Add blend）才能隐藏。
    // 每次冷加载都得触发一次，否则首帧会出现提示文字。
    modelFile: "玳瑁猫v1_vts.model3.json",
    expression: "关闭提示",
  },
]

/** 从任意路径里提取 basename（兼容 Windows/Unix 反斜杠）。 */
function basename(path: string): string {
  const norm = path.replace(/\\/g, "/")
  const slash = norm.lastIndexOf("/")
  return slash >= 0 ? norm.substring(slash + 1) : norm
}

/** 在 MODEL_LOAD_QUIRKS 里查找当前 modelPath 对应的加载期特殊规则。 */
function findLoadQuirk(modelPath: string): { expression: string } | null {
  const base = basename(modelPath)
  const hit = MODEL_LOAD_QUIRKS.find((q) => q.modelFile === base)
  return hit ? { expression: hit.expression } : null
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a local filesystem path to a renderer-loadable URL.
 * - Local absolute paths use the app's `live2d-local://` protocol so Vite dev
 *   and packaged renderer pages can fetch model-relative textures and Core JS.
 */
function toResourceUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    throw new Error("v0.1 仅支持加载本地 Live2D 模型路径")
  }
  if (path.startsWith("file://")) {
    const url = new URL(path)
    return toResourceUrl(decodeURIComponent(url.pathname))
  }
  // Windows absolute path: C:\path\to\file or C:/path/to/file
  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    return "live2d-local:///" + path.replace(/\\/g, "/")
  }
  // Unix absolute path
  if (path.startsWith("/")) {
    return "live2d-local://" + path
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
  /**
   * Latest emotion parsed from the assistant message. `null` means the
   * system is disabled or no message has been received yet — in that case
   * the Live2D layer should not switch to a fallback expression.
   */
  emotion?: Emotion | null
  /**
   * Optional per-emotion profile. When omitted, `DEFAULT_LIVE2D_EMOTION_PROFILE`
   * is used. Users can hand-write this in `settings.json` under
   * `live2d.emotionProfile` to point each emotion at the actual motion /
   * expression names that their model ships with.
   */
  emotionProfile?: Live2DEmotionProfile
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Live2DView({ modelPath, avatarState, emotion, emotionProfile }: Live2DViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const modelRef = useRef<InstanceType<any> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modelEpoch, setModelEpoch] = useState(0)

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

  /* ---- 4. React to LLM-parsed emotions ---- */
  useEffect(() => {
    const model = modelRef.current
    if (!model) return
    if (emotion === undefined || emotion === null) return

    const profile = emotionProfile ?? DEFAULT_LIVE2D_EMOTION_PROFILE
    const binding = resolveEmotionBinding(profile, emotion)
    // Missing binding (not even neutral) ⇒ leave the current pose alone.
    if (!binding) return
    if (binding.motion) playMotion(model, binding.motion, binding.motionIndex)
    if (binding.expression) trySetExpression(model, binding.expression)
  }, [emotion, modelEpoch, emotionProfile])

  /* ---- Internal helpers ---- */

  /**
   * Dynamically load the Cubism Core JS from a path relative to the model.
   * This must complete before pixi-live2d-display-lipsyncpatch is imported.
   */
  async function loadCubismCore(modelPath: string): Promise<void> {
    if (window.Live2DCubismCore) return
    if (cubismCorePromise) return cubismCorePromise

    cubismCorePromise = new Promise<void>((resolve, reject) => {
      const modelUrl = toResourceUrl(modelPath)
      const slashIdx = modelUrl.lastIndexOf("/")
      const dirUrl = modelUrl.substring(0, slashIdx + 1)
      let coreUrl: string
      try {
        coreUrl = new URL("../live2dcubismcore.min.js", dirUrl).href
      } catch {
        reject(new Error("Failed to resolve Cubism Core URL"))
        return
      }

      const script = document.createElement("script")
      script.src = coreUrl
      script.onload = () => resolve()
      script.onerror = () => {
        script.remove()
        if (cubismCoreScript === script) cubismCoreScript = null
        cubismCorePromise = null
        reject(new Error(`Cubism Core 加载失败: ${coreUrl}`))
      }
      cubismCoreScript = script
      document.head.appendChild(script)
    })

    return cubismCorePromise
  }

  async function loadModel(path: string): Promise<void> {
    try {
      window.PIXI = PIXI
      await loadCubismCore(path)
      const { Live2DModel } = await import("pixi-live2d-display-lipsyncpatch/cubism4")
      const url = toResourceUrl(path)
      const model = await Live2DModel.from(url)

      modelRef.current = model
      appRef.current!.stage.addChild(model)

      centerModel(model)
      setLoadError(null)

      // ---- 模型加载完成：触发一次性"特殊规则" ----
      // 某些模型（比如 玳瑁猫v1_vts）默认会显示内置提示层，
      // 必须激活一次对应的 exp3.json 才能关掉。这里在渲染前先发一次，
      // 保证首帧就是干净状态；后续 emotion / avatarState 切换不会重复触发。
      const quirk = findLoadQuirk(path)
      if (quirk) {
        trySetExpression(model, quirk.expression)
      }

      // Bump the epoch *after* the model is fully loaded so the emotion
      // effect's `if (!model) return` guard always sees a live model ref.
      // This re-applies the current emotion to the freshly loaded model.
      setModelEpoch((value) => value + 1)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("Cubism Core")) {
        setLoadError(`Live2D 加载失败：无法加载 Cubism Core JS`)
      } else {
        setLoadError("Live2D 加载失败，使用 fallback 显示")
      }
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

    const scale = Math.min(cw / mw, ch / mh) * 0.95
    model.scale.set(scale)
    model.position.set(app.screen.width / 2, app.screen.height / 2)

    if (typeof model.anchor?.set === "function") {
      model.anchor.set(0.5, 0.5)
    }
  }

  /* Re-center model when container resizes (e.g. drag handle or window resize) */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const model = modelRef.current
      if (model) centerModel(model)
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

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

  function playMotion(model: InstanceType<any>, group: string, index?: number): void {
    try {
      if (typeof index === "number") {
        model.motion?.(group, index)
      } else {
        model.motion?.(group)
      }
    } catch (err) {
      console.warn(`[Live2DView] motion failed: ${group}`, err)
    }
  }

  function trySetExpression(model: InstanceType<any>, name: string): void {
    try {
      model.expression?.(name)
    } catch (err) {
      console.warn(`[Live2DView] expression failed: ${name}`, err)
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
