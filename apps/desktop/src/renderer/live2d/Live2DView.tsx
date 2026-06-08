import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import * as PIXI from "pixi.js"
import type { AvatarState } from "@live2d-agent/live2d"
import {
  DEFAULT_LIVE2D_EMOTION_PROFILE,
  resolveEmotionBinding,
  type Emotion,
  type Live2DEmotionProfile,
} from "@live2d-agent/shared"
import type { AvatarHitRegionRect } from "@live2d-agent/shared"

declare global {
  interface Window {
    PIXI?: typeof PIXI
    Live2DCubismCore?: unknown
  }
}

let cubismCorePromise: Promise<void> | null = null
let cubismCoreScript: HTMLScriptElement | null = null
const MODEL_HIT_REGION_PADDING_PX = 8
const MODEL_HIT_REGION_SAMPLE_STEP_PX = 10

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
 *
 * 关于 `parameterPins`：
 *   一些 quirk 表情使用 Add blend 配方（如 Param6=1.0 关闭提示层）。
 *   这类表情一旦被新的 expression() 调用覆盖，会被 expression queue
 *   fade out，Param6 就会回到 base=0.0，提示层重新出现。仅靠
 *   "加载时触发一次" 是不够的——还需要在每次 model.expression() /
 *   model.motion() 之后，用 Cubism 的 setParameterValueById 把相关
 *   参数强行 pin 到目标值。这个字段就是给这种情况用的。
 */
const MODEL_LOAD_QUIRKS: ReadonlyArray<{
  /** model3.json 的文件名（含 .model3.json 后缀），按 basename 匹配。 */
  modelFile: string
  /** 加载完成后自动触发一次的表情名（对应 .exp3.json 的文件名）。 */
  expression: string
  /**
   * 模型加载后需要持续 pin 住的参数。在每次 expression / motion 调用
   * 之后都会重新写入 coreModel._parameterValues，确保不被新的 expression
   * 队列 fade out 抹掉。
   */
  parameterPins?: ReadonlyArray<{ id: string; value: number }>
}> = [
  {
    // 玳瑁猫 v1（VTS 版本）默认带一个 Param6 控制的内置提示层，
    // 必须激活 `关闭提示.exp3.json`（Param6=1.0, Add blend）才能隐藏。
    // 每次冷加载都得触发一次，否则首帧会出现提示文字。
    // 之后还要把 Param6 持续 pin 在 1.0，否则任何一次 emotion / avatarState
    // 切换都会让 expression queue 把"关闭提示" fade out 掉，提示层
    // 重新出现。详见本文件 applyParameterPins()。
    modelFile: "玳瑁猫v1_vts.model3.json",
    expression: "关闭提示",
    parameterPins: [{ id: "Param6", value: 1.0 }],
  },
]

/** 从任意路径里提取 basename（兼容 Windows/Unix 反斜杠）。 */
function basename(path: string): string {
  const norm = path.replace(/\\/g, "/")
  const slash = norm.lastIndexOf("/")
  return slash >= 0 ? norm.substring(slash + 1) : norm
}

/** 在 MODEL_LOAD_QUIRKS 里查找当前 modelPath 对应的加载期特殊规则。 */
function findLoadQuirk(modelPath: string): {
  expression: string
  parameterPins: ReadonlyArray<{ id: string; value: number }>
} | null {
  const base = basename(modelPath)
  const hit = MODEL_LOAD_QUIRKS.find((q) => q.modelFile === base)
  return hit
    ? { expression: hit.expression, parameterPins: hit.parameterPins ?? [] }
    : null
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
  /** Called when the approximate OS hit region may have changed. */
  onInteractiveRectsChanged?: (rects: AvatarHitRegionRect[]) => void
}

export interface Live2DViewHandle {
  playMotion: (group: string, index?: number) => void
  setExpression: (name: string) => void
  clearExpression: () => void
  containsPoint: (clientX: number, clientY: number) => boolean
  getInteractiveRects: () => AvatarHitRegionRect[]
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Live2DView = forwardRef<Live2DViewHandle, Live2DViewProps>(function Live2DView(
  { modelPath, avatarState, emotion, emotionProfile, onInteractiveRectsChanged },
  ref,
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const modelRef = useRef<InstanceType<any> | null>(null)
  /**
   * 加载时命中的 quirk 规则所要求的"持续 pin 住"的参数。
   * 见 MODEL_LOAD_QUIRKS.parameterPins。每次 model.expression() /
   * model.motion() 之后都会按这张表重新写一次 coreModel。
   */
  const activeQuirksRef = useRef<ReadonlyArray<{ id: string; value: number }>>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modelEpoch, setModelEpoch] = useState(0)

  useImperativeHandle(ref, () => ({
    playMotion: (group: string, index?: number) => {
      const model = modelRef.current
      if (!model) return
      playMotion(model, group, index)
    },
    setExpression: (name: string) => {
      const model = modelRef.current
      if (!model) return
      trySetExpression(model, name)
    },
    clearExpression: () => {
      const model = modelRef.current
      if (!model) return
      clearExpression(model)
    },
    containsPoint: (clientX: number, clientY: number) =>
      containsModelPoint(clientX, clientY) || containsFallbackPoint(clientX, clientY),
    getInteractiveRects: () => getInteractiveRects(),
  }), [])

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
      scheduleInteractiveRectsChanged()
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
    if (binding.expression) {
      trySetExpression(model, binding.expression)
    } else if (emotion === "neutral") {
      // Returning to the normal idle emotion should also clear any transient
      // expression that was applied by the previous emotion tag.
      trySetExpression(model, "idle")
    }
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
      // 如果该 quirk 还声明了 parameterPins（例如把 Param6 持续 pin 在 1.0），
      // 也要写到 activeQuirksRef 里，让后续的 playMotion / trySetExpression
      // 在每次调用后自动重新写入核心参数，避免 expression queue fade out
      // 把 quirk 表情抹掉。
      const quirk = findLoadQuirk(path)
      activeQuirksRef.current = quirk?.parameterPins ?? []
      if (quirk) {
        trySetExpression(model, quirk.expression)
      }

      // Bump the epoch *after* the model is fully loaded so the emotion
      // effect's `if (!model) return` guard always sees a live model ref.
      // This re-applies the current emotion to the freshly loaded model.
      setModelEpoch((value) => value + 1)
      scheduleInteractiveRectsChanged()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("Cubism Core")) {
        setLoadError(`Live2D 加载失败：无法加载 Cubism Core JS`)
      } else {
        setLoadError("Live2D 加载失败，使用 fallback 显示")
      }
      console.error("[Live2DView] Failed to load model:", err)
      scheduleInteractiveRectsChanged()
    }
  }

  function centerModel(model: InstanceType<any>): void {
    const app = appRef.current
    const container = containerRef.current
    if (!app || !container) return

    const cw = app.screen.width || container.clientWidth || 300
    const ch = app.screen.height || container.clientHeight || 300
    model.scale.set(1)
    const mw = model.width || 1
    const mh = model.height || 1

    const scale = Math.min(cw / mw, ch / mh) * 1.0
    model.scale.set(scale)
    model.position.set(app.screen.width / 2, app.screen.height * 0.5)

    if (typeof model.anchor?.set === "function") {
      model.anchor.set(0.5, 0.5)
    }
  }

  /* Re-center model when container resizes (e.g. drag handle or window resize) */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const resizeModel = () => {
      appRef.current?.resize()
      const model = modelRef.current
      if (model) centerModel(model)
      scheduleInteractiveRectsChanged()
    }
    const ro = new ResizeObserver(resizeModel)
    ro.observe(container)
    window.addEventListener("resize", resizeModel)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", resizeModel)
    }
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
      scheduleInteractiveRectsChanged()
    }
    // 清空 quirk 引用，避免新模型继承上一任的 parameterPins。
    activeQuirksRef.current = []
  }

  function containsModelPoint(clientX: number, clientY: number): boolean {
    const model = modelRef.current
    const container = containerRef.current
    if (!model || !container) return false

    const rect = container.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false

    if (typeof model.hitTest === "function") {
      const hitAreas = collectHitAreas(model)
      for (const name of hitAreas) {
        try {
          if (model.hitTest(name, x, y)) return true
        } catch {
          // Some pixi-live2d-display versions use a different hitTest shape.
        }
      }
      // Do not fall back to the model bounding rectangle: Live2D bounds include
      // large transparent pixels, which would make the transparent background
      // clickable and break OS-level passthrough.
    }

    return false
  }

  function containsFallbackPoint(clientX: number, clientY: number): boolean {
    const fallback = fallbackRef.current
    if (!fallback) return false

    const rect = fallback.getBoundingClientRect()
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    )
  }

  function getInteractiveRects(): AvatarHitRegionRect[] {
    const model = modelRef.current
    const container = containerRef.current
    const app = appRef.current

    if (model && container && app) {
      // Model state: return approximate model bounds in viewport coordinates
      try {
        const sampled = getSampledHitTestRect(model, container)
        if (sampled) return [sampled]

        // Try model.getBounds() first (pixi-live2d-display)
        let bounds: { x: number; y: number; width: number; height: number } | null = null
        if (typeof model.getBounds === "function") {
          const b = model.getBounds()
          if (b && typeof b === "object") {
            bounds = { x: b.x ?? b.left ?? 0, y: b.y ?? b.top ?? 0, width: b.width ?? 0, height: b.height ?? 0 }
          }
        }
        if (!bounds) {
          // Fallback: use model.width/height + position from the PIXI stage
          const pos = model.position ?? { x: 0, y: 0 }
          const mw = model.width || 0
          const mh = model.height || 0
          bounds = {
            x: pos.x - mw / 2,
            y: pos.y - mh / 2,
            width: mw,
            height: mh,
          }
        }

        // Convert from PIXI local coords to viewport coords via container bounding rect
        const containerRect = container.getBoundingClientRect()
        // PIXI screen coordinates are logical CSS pixels even when the renderer
        // uses a higher devicePixelRatio backing store.
        const scaleX = containerRect.width / (app.screen.width || containerRect.width || 1)
        const scaleY = containerRect.height / (app.screen.height || containerRect.height || 1)

        const viewportRect: AvatarHitRegionRect = {
          x: Math.round(containerRect.left + bounds.x * scaleX),
          y: Math.round(containerRect.top + bounds.y * scaleY),
          width: Math.round(bounds.width * scaleX),
          height: Math.round(bounds.height * scaleY),
        }

        const paddedRect = {
          x: viewportRect.x - MODEL_HIT_REGION_PADDING_PX,
          y: viewportRect.y - MODEL_HIT_REGION_PADDING_PX,
          width: viewportRect.width + MODEL_HIT_REGION_PADDING_PX * 2,
          height: viewportRect.height + MODEL_HIT_REGION_PADDING_PX * 2,
        }

        // Clip to container viewport rect
        const crLeft = Math.round(containerRect.left)
        const crTop = Math.round(containerRect.top)
        const crRight = Math.round(containerRect.right)
        const crBottom = Math.round(containerRect.bottom)

        const clippedX = Math.max(paddedRect.x, crLeft)
        const clippedY = Math.max(paddedRect.y, crTop)
        const clippedW = Math.min(paddedRect.x + paddedRect.width, crRight) - clippedX
        const clippedH = Math.min(paddedRect.y + paddedRect.height, crBottom) - clippedY

        if (clippedW > 0 && clippedH > 0) {
          return [{ x: clippedX, y: clippedY, width: clippedW, height: clippedH }]
        }
      } catch {
        // ignore bounds errors
      }
    }

    // Fallback state: return fallback DOM element rect
    const fallback = fallbackRef.current
    if (fallback) {
      const rect = fallback.getBoundingClientRect()
      const r: AvatarHitRegionRect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      if (r.width > 0 && r.height > 0) return [r]
    }

    return []
  }

  function getSampledHitTestRect(model: InstanceType<any>, container: HTMLDivElement): AvatarHitRegionRect | null {
    if (typeof model.hitTest !== "function") return null

    const hitAreas = collectHitAreas(model)
    if (hitAreas.length === 0) return null

    const containerRect = container.getBoundingClientRect()
    const bounds = getModelLocalBounds(model, containerRect)
    if (!bounds) return null

    const startX = Math.max(0, Math.floor(bounds.x))
    const startY = Math.max(0, Math.floor(bounds.y))
    const endX = Math.min(containerRect.width, Math.ceil(bounds.x + bounds.width))
    const endY = Math.min(containerRect.height, Math.ceil(bounds.y + bounds.height))
    if (endX <= startX || endY <= startY) return null

    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    for (let y = startY; y <= endY; y += MODEL_HIT_REGION_SAMPLE_STEP_PX) {
      for (let x = startX; x <= endX; x += MODEL_HIT_REGION_SAMPLE_STEP_PX) {
        if (!hitTestModelAreas(model, hitAreas, x, y)) continue
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null

    const pad = MODEL_HIT_REGION_PADDING_PX + MODEL_HIT_REGION_SAMPLE_STEP_PX
    const localX = Math.max(0, minX - pad)
    const localY = Math.max(0, minY - pad)
    const localRight = Math.min(containerRect.width, maxX + pad)
    const localBottom = Math.min(containerRect.height, maxY + pad)
    const width = Math.round(localRight - localX)
    const height = Math.round(localBottom - localY)
    if (width <= 0 || height <= 0) return null

    return {
      x: Math.round(containerRect.left + localX),
      y: Math.round(containerRect.top + localY),
      width,
      height,
    }
  }

  function getModelLocalBounds(
    model: InstanceType<any>,
    containerRect: DOMRect,
  ): { x: number; y: number; width: number; height: number } | null {
    const app = appRef.current
    if (!app) return null

    if (typeof model.getBounds === "function") {
      const b = model.getBounds()
      if (b && typeof b === "object") {
        const scaleX = containerRect.width / (app.screen.width || containerRect.width || 1)
        const scaleY = containerRect.height / (app.screen.height || containerRect.height || 1)
        return {
          x: (b.x ?? b.left ?? 0) * scaleX,
          y: (b.y ?? b.top ?? 0) * scaleY,
          width: (b.width ?? 0) * scaleX,
          height: (b.height ?? 0) * scaleY,
        }
      }
    }

    const pos = model.position ?? { x: 0, y: 0 }
    const mw = model.width || 0
    const mh = model.height || 0
    return { x: pos.x - mw / 2, y: pos.y - mh / 2, width: mw, height: mh }
  }

  function hitTestModelAreas(model: InstanceType<any>, hitAreas: string[], x: number, y: number): boolean {
    for (const name of hitAreas) {
      try {
        if (model.hitTest(name, x, y)) return true
      } catch {
        // Some pixi-live2d-display versions use a different hitTest shape.
      }
    }
    return false
  }

  function scheduleInteractiveRectsChanged(): void {
    if (!onInteractiveRectsChanged) return
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        onInteractiveRectsChanged(getInteractiveRects())
      })
    })
  }

  function collectHitAreas(model: InstanceType<any>): string[] {
    const names = new Set<string>(["Body", "Head", "body", "head"])
    const rawHitAreas = model?.internalModel?.settings?.hitAreas
      ?? model?.internalModel?.settings?.HitAreas
      ?? model?.settings?.hitAreas
      ?? []
    if (Array.isArray(rawHitAreas)) {
      for (const area of rawHitAreas) {
        const name = area?.name ?? area?.Name ?? area?.id ?? area?.Id
        if (typeof name === "string" && name.length > 0) names.add(name)
      }
    }
    return [...names]
  }

  /**
   * 把当前 activeQuirksRef 里的参数强行写回 coreModel。
   *
   * 背景：Cubism 的 expression queue 在调用 model.expression() 时会把旧
   * 表情 fade out（cubism4.es.js:4266 startMotion 内的 fadeOut 循环）。
   * 一些 quirk 表情用 Add blend（如 Param6=1.0）作为"加载即触发一次"的
   * 副作用；一旦被后续 emotion / avatarState 切换覆盖，相关参数权重
   * 就会淡回 0，副作用消失。这里在每次 expression / motion 之后用
   * CubismModel.setParameterValueById 直接写 _parameterValues，绕过
   * expression queue，强制把参数 pin 住。
   *
   * 因为 CoreModel 的 update 顺序是 motion → save → expression → ... →
   * model.update() → loadParameters()（见 cubism4.es.js:10867-10901），
   * 这里的写入在下一帧会被 saveParameters 拍下，渲染也以这时的值为准，
   * 随后 loadParameters 又会从 _savedParameters 复位——所以下一帧
   * 直接以写入后的值起步，效果是持续生效的。
   */
  function applyParameterPins(model: InstanceType<any>): void {
    const pins = activeQuirksRef.current
    if (pins.length === 0) return
    const core = model?.internalModel?.coreModel
    if (!core || typeof core.setParameterValueById !== "function") return
    for (const pin of pins) {
      try {
        core.setParameterValueById(pin.id, pin.value)
      } catch (err) {
        // 切到没有该参数 ID 的模型时（例如不同 base），不应炸；
        // 静默忽略，下一次 emotion 切换时仍会尝试。
        console.warn(`[Live2DView] parameter pin failed: ${pin.id}`, err)
      }
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
    applyParameterPins(model)
  }

  function trySetExpression(model: InstanceType<any>, name: string): void {
    try {
      model.expression?.(name)
    } catch (err) {
      console.warn(`[Live2DView] expression failed: ${name}`, err)
    }
    applyParameterPins(model)
  }

  function clearExpression(model: InstanceType<any>): void {
    const motionManager = model?.internalModel?.motionManager
    const expressionManager = motionManager?.expressionManager
    try {
      expressionManager?.stopAllMotions?.()
      expressionManager?.queueManager?.stopAllMotions?.()
      expressionManager?.motionQueueManager?.stopAllMotions?.()
      if ("currentExpression" in (expressionManager ?? {})) {
        expressionManager.currentExpression = undefined
      }
      if ("reservedExpression" in (expressionManager ?? {})) {
        expressionManager.reservedExpression = undefined
      }
    } catch (err) {
      console.warn("[Live2DView] clear expression failed", err)
    }
    applyParameterPins(model)
  }

  /* ---- Render ---- */

  const showFallback = !modelPath || loadError !== null
  const fallbackClass = loadError ? "avatar-orb fallback-error" : "avatar-orb fallback-empty"

  return (
    <div className="live2d-container" ref={containerRef}>
      {showFallback && <div ref={fallbackRef} className={fallbackClass}>{loadError || "Live2D"}</div>}
    </div>
  )
})
