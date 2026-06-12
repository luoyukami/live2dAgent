import { BrowserWindow, screen } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type { CompactInputAnchor, PublicSettings, UiSettings, AvatarHitRegionRect } from "@live2d-agent/shared"

const isDev = process.env.NODE_ENV === "development"
const currentDir = dirname(fileURLToPath(import.meta.url))

type WindowRole = "avatar" | "ui" | "combined"

export class WindowManager {
  /** Single-window (combined) mode — the default behaviour. */
  private combinedWindow?: BrowserWindow

  /** Dual-window mode — dedicated avatar / UI windows. */
  private avatarWindow?: BrowserWindow
  private uiWindow?: BrowserWindow

  /** Current UI mode for the dual-window UI window. */
  private uiMode: "hidden" | "compact" | "detail" = "hidden"

  /** Set to true when the app is quitting, to allow window destruction. */
  private isQuitting = false

  /** Drag state — supports both combined and avatar windows. */
  private dragTimer?: NodeJS.Timeout
  private dragStart?: {
    windowType: "combined" | "avatar"
    cursorX: number; cursorY: number
    windowX: number; windowY: number
    windowWidth: number; windowHeight: number
    contentWidth: number; contentHeight: number
  }

  private getDragWindow(windowType: "combined" | "avatar"): BrowserWindow | undefined {
    return windowType === "avatar" ? this.avatarWindow : this.combinedWindow
  }

  private lockedSize?: { width: number; height: number }

  /** Per-window content-size locks to prevent DPI drift during drag/resize. */
  private lockedContentSizes = new Map<WindowRole, { width: number; height: number }>()

  /** Timer for delayed hide to avoid race conditions. */
  private hideTimer?: NodeJS.Timeout

  /** Current detail panel tab (for re-show after resize). */
  private currentDetailTab: "chat" | "settings" | "debug" = "chat"

  /** User-configured panel dimensions. */
  private panelWidth = 460
  private panelHeight = 760

  /** Cached normalized hit-region rects for OS-level shape on avatar window. */
  private cachedAvatarHitRects: AvatarHitRegionRect[] = []

  /** Suspend setShape during avatar drag to avoid size feedback loops. */
  private isDraggingAvatar = false
  private pendingAvatarHitShape = false

  /** Last applied avatar mouse-ignore state, used to avoid noisy native calls/logs. */
  private avatarMouseIgnored?: boolean

  // ════════════════════════════════════════════════════════════════
  //  Single-window (combined) mode — backward-compatible API
  // ════════════════════════════════════════════════════════════════

  /**
   * Create the combined single window (current default behaviour).
   * The renderer loads without a `?window=` query param, which signals
   * the monolithic App root (default `"combined"` role).
   */
  async create(ui?: Pick<UiSettings, "width" | "height">): Promise<void> {
    const display = screen.getPrimaryDisplay()
    const { width: workWidth, height: workHeight } = display.workAreaSize
    const windowWidth = clampWindowDimension(ui?.width, 360)
    const windowHeight = clampWindowDimension(ui?.height, 720)

    this.combinedWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      useContentSize: true,
      x: Math.max(0, workWidth - windowWidth - 20),
      y: Math.max(0, workHeight - windowHeight - 20),
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      hasShadow: false,
      webPreferences: {
        preload: join(currentDir, "../preload/index.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })

    this.combinedWindow.setMenuBarVisibility(false)
    this.combinedWindow.setMaximizable(false)
    this.lockCurrentWindowSize(this.combinedWindow)

    await this.loadRenderer(this.combinedWindow)
  }

  /** Whether the combined single-window still exists. */
  hasWindow(): boolean {
    return this.combinedWindow !== undefined && !this.combinedWindow.isDestroyed()
  }

  /** Send an AgentEvent to the combined window (backward compat). */
  sendAgentEvent(event: AgentEvent): void {
    this.combinedWindow?.webContents.send(IPC_CHANNELS.ON_AGENT_EVENT, event)
  }

  setSize(width: number, height: number): void {
    const nextWidth = clampWindowDimension(width, 360)
    const nextHeight = clampWindowDimension(height, 720)

    // In dual mode, resize the avatar window only; the UI window keeps its own size.
    if (this.avatarWindow && !this.avatarWindow.isDestroyed()) {
      this.avatarWindow.setMinimumSize(200, 200)
      this.avatarWindow.setMaximumSize(4000, 4000)
      this.avatarWindow.setContentSize(nextWidth, nextHeight, false)
      this.applyAvatarHitShape()
      return
    }

    if (!this.combinedWindow || this.combinedWindow.isDestroyed()) return
    this.combinedWindow.setMinimumSize(200, 200)
    this.combinedWindow.setMaximumSize(4000, 4000)
    this.combinedWindow.setContentSize(nextWidth, nextHeight, false)
    this.lockCurrentWindowSize(this.combinedWindow)
  }

  moveBy(dx: number, dy: number): void {
    if (!this.combinedWindow || this.combinedWindow.isDestroyed()) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = this.combinedWindow.getPosition()
    this.combinedWindow.setPosition(Math.round(x + dx), Math.round(y + dy), false)
    this.restoreLockedSize(this.combinedWindow)
  }

  startDrag(windowType: "combined" | "avatar" = "combined"): void {
    const target = this.getDragWindow(windowType)
    if (!target || target.isDestroyed()) return
    this.endDrag()
    const cursor = screen.getCursorScreenPoint()
    const bounds = target.getBounds()
    const [contentWidth, contentHeight] = target.getContentSize()
    this.dragStart = {
      windowType,
      cursorX: cursor.x,
      cursorY: cursor.y,
      windowX: bounds.x,
      windowY: bounds.y,
      windowWidth: bounds.width,
      windowHeight: bounds.height,
      contentWidth,
      contentHeight,
    }
    if (windowType === "avatar") {
      this.isDraggingAvatar = true
    }
    this.dragTimer = setInterval(() => this.updateDragPosition(), 16)
  }

  endDrag(_windowType?: "combined" | "avatar"): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = undefined
    }
    const wasDraggingAvatar = this.dragStart?.windowType === "avatar"
    this.dragStart = undefined
    if (wasDraggingAvatar) {
      this.isDraggingAvatar = false
      if (this.pendingAvatarHitShape) {
        this.pendingAvatarHitShape = false
        this.applyAvatarHitShape()
      }
    }
  }

  private updateDragPosition(): void {
    if (!this.dragStart) {
      this.endDrag()
      return
    }
    const target = this.getDragWindow(this.dragStart.windowType)
    if (!target || target.isDestroyed()) {
      this.endDrag()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const nextX = Math.round(this.dragStart.windowX + cursor.x - this.dragStart.cursorX)
    const nextY = Math.round(this.dragStart.windowY + cursor.y - this.dragStart.cursorY)

    // Atomic position + fixed size to prevent DPI-induced drift
    target.setBounds({
      x: nextX,
      y: nextY,
      width: this.dragStart.windowWidth,
      height: this.dragStart.windowHeight,
    }, false)

    // Restore content size if it drifted during the setBounds call
    const [cw, ch] = target.getContentSize()
    if (cw !== this.dragStart.contentWidth || ch !== this.dragStart.contentHeight) {
      target.setContentSize(this.dragStart.contentWidth, this.dragStart.contentHeight, false)
    }

    if (this.dragStart.windowType === "combined") {
      this.restoreLockedSize(target)
    }
  }

  setMousePassthrough(enabled: boolean, windowType: "combined" | "avatar" = "combined"): void {
    if (windowType === "avatar") {
      if (!this.avatarWindow || this.avatarWindow.isDestroyed()) return
      if (process.platform === "darwin") {
        // macOS: allow dynamic toggle for fallback mousemove passthrough
        this.setAvatarIgnoreMouseEvents(enabled, "darwin-fallback")
      } else {
        // Non-macOS: ignore renderer's dynamic toggles. setShape constrains the
        // native hit-test area, so false is safe only when at least one shaped
        // interactive rect exists; otherwise keep the full window pass-through.
        this.applyAvatarHitShape()
      }
      return
    }
    if (!this.combinedWindow || this.combinedWindow.isDestroyed()) return
    this.combinedWindow.setIgnoreMouseEvents(enabled, { forward: true })
  }

  /**
   * Receive hit-region rects from the renderer and apply OS-level shape
   * on Windows/Linux (setShape). macOS only caches — dynamic passthrough
   * remains the fallback strategy.
   *
   * Rects are normalized: integers, finite, positive width/height, clamped
   * to the current avatar content bounds, max 256 entries.
   */
  setAvatarHitRegion(rects: AvatarHitRegionRect[]): void {
    if (!this.avatarWindow || this.avatarWindow.isDestroyed()) return

    const normalized = this.normalizeHitRects(rects)

    // Avoid redundant shape application
    if (this.hitRectsEqual(this.cachedAvatarHitRects, normalized)) return

    this.cachedAvatarHitRects = normalized

    // macOS: only cache — no setShape, dynamic passthrough via mousemove is the fallback
    if (process.platform === "darwin") return

    // During avatar drag, defer shape application to avoid size feedback loops
    if (this.isDraggingAvatar) {
      this.pendingAvatarHitShape = true
      return
    }

    // Windows / Linux: apply OS-level shape
    this.applyAvatarHitShape()
  }

  /** Apply the cached hit rects as the avatar window's OS-level shape. */
  private applyAvatarHitShape(): void {
    if (!this.avatarWindow || this.avatarWindow.isDestroyed()) return
    if (process.platform === "darwin") return

    if (this.cachedAvatarHitRects.length === 0) {
      // No hit regions — make the whole window pass-through
      this.setAvatarIgnoreMouseEvents(true, "empty-shape")
      this.avatarWindow.setShape([])
      return
    }

    // Electron's setShape expects Electron.Rectangle[]
    const shape = this.cachedAvatarHitRects.map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }))
    this.avatarWindow.setShape(shape)

    // setShape changes the native window region on Windows/Linux. Keep the
    // region as a stable padded rectangle so visible model pixels stay on top,
    // while outside the region passes through to apps below.
    this.setAvatarIgnoreMouseEvents(false, "shape-applied")
  }

  private setAvatarIgnoreMouseEvents(enabled: boolean, reason: string): void {
    if (!this.avatarWindow || this.avatarWindow.isDestroyed()) return
    if (this.avatarMouseIgnored === enabled) return
    this.avatarMouseIgnored = enabled
    this.avatarWindow.setIgnoreMouseEvents(enabled, { forward: true })
    if (isDev) {
      console.debug(`[WindowManager] avatar ignoreMouseEvents=${enabled} (${reason})`)
    }
  }

  /** Keep the companion UI above the avatar while compact/detail UI is visible. */
  private keepUiAboveAvatar(): void {
    if (!this.uiWindow || this.uiWindow.isDestroyed()) return
    this.uiWindow.setAlwaysOnTop(true, "pop-up-menu")
    try {
      this.uiWindow.moveTop()
    } catch {
      // moveTop is best-effort; alwaysOnTop level is the primary ordering guard.
    }
  }

  /** Normalize, clamp, and deduplicate a set of hit rects to the avatar content bounds. */
  private normalizeHitRects(rects: AvatarHitRegionRect[]): AvatarHitRegionRect[] {
    if (!this.avatarWindow || this.avatarWindow.isDestroyed()) return []

    const maxRects = 256
    const [cw, ch] = this.avatarWindow.getContentSize()
    const result: AvatarHitRegionRect[] = []

    for (const r of rects) {
      if (result.length >= maxRects) break
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.width) || !Number.isFinite(r.height)) continue
      let w = Math.round(r.width)
      let h = Math.round(r.height)
      if (w <= 0 || h <= 0) continue
      let x = Math.round(r.x)
      let y = Math.round(r.y)

      // Clamp to content bounds
      if (x < 0) {
        const visible = w + x
        if (visible <= 0) continue
        w = visible
        x = 0
      }
      if (y < 0) {
        const visible = h + y
        if (visible <= 0) continue
        h = visible
        y = 0
      }
      if (x + w > cw) {
        const clipped = cw - x
        if (clipped <= 0) continue
        w = clipped
      }
      if (y + h > ch) {
        const clipped = ch - y
        if (clipped <= 0) continue
        h = clipped
      }
      result.push({ x, y, width: w, height: h })
    }

    return result
  }

  /** Shallow equality check for normalized hit rects. */
  private hitRectsEqual(a: AvatarHitRegionRect[], b: AvatarHitRegionRect[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].width !== b[i].width || a[i].height !== b[i].height) return false
    }
    return true
  }

  // ════════════════════════════════════════════════════════════════
  //  Dual-window mode — default startup (Phase 5+)
  // ════════════════════════════════════════════════════════════════

  /**
   * Create separate avatar + UI windows.
   *
   * - **Avatar window**: transparent, frameless, always-on-top, skip taskbar.
   *   Interactive only when mouse is over the Live2D model area (dynamic passthrough).
   *   Loads renderer with `?window=avatar`.
   * - **UI window**: transparent, frameless, always-on-top, skip taskbar.
   *   Starts hidden, shown on demand via showCompactInput/showDetailPanel.
   *   Loads renderer with `?window=ui`.
   *
   * Both windows share the same preload and context‑isolation settings.
   * This is the default startup mode (called from `bootstrap()` in main.ts).
   * The combined single-window `create()` path remains as a fallback.
   */
  async createDual(ui?: Pick<UiSettings, "width" | "height" | "panelWidth" | "panelHeight">): Promise<void> {
    const display = screen.getPrimaryDisplay()
    const { width: workWidth, height: workHeight } = display.workAreaSize
    const avatarWidth = clampWindowDimension(ui?.width, 360)
    const avatarHeight = clampWindowDimension(ui?.height, 720)
    this.panelWidth = clampWindowDimension(ui?.panelWidth, 460)
    this.panelHeight = clampWindowDimension(ui?.panelHeight, 760)

    // ── Avatar window ───────────────────────────────────────────
    this.avatarWindow = new BrowserWindow({
      width: avatarWidth,
      height: avatarHeight,
      useContentSize: true,
      x: Math.max(0, workWidth - avatarWidth - 20),
      y: Math.max(0, workHeight - avatarHeight - 20),
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      focusable: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: join(currentDir, "../preload/index.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.avatarWindow.setMenuBarVisibility(false)
    this.avatarWindow.setMaximizable(false)
    this.avatarWindow.setAlwaysOnTop(true, "floating")
    this.cachedAvatarHitRects = []
    this.avatarMouseIgnored = undefined
    this.setAvatarIgnoreMouseEvents(true, "initial")
    await this.loadRenderer(this.avatarWindow, "avatar")
    this.lockWindowContentSize("avatar", this.avatarWindow)

    // ── UI window ───────────────────────────────────────────────
    // Use compact input dimensions initially; will be resized when switching modes.
    const COMPACT_WIDTH = 420
    const COMPACT_HEIGHT = 150

    const uiPos = this.positionBelowAvatar(COMPACT_WIDTH, COMPACT_HEIGHT)

    this.uiWindow = new BrowserWindow({
      width: COMPACT_WIDTH,
      height: COMPACT_HEIGHT,
      useContentSize: true,
      x: uiPos.x,
      y: uiPos.y,
      show: false,           // <-- 启动时隐藏
      transparent: true,     // <-- 支持透明
      backgroundColor: "#00000000",
      frame: false,          // <-- 无边框
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,     // <-- 不在任务栏显示
      hasShadow: false,
      webPreferences: {
        preload: join(currentDir, "../preload/index.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.uiWindow.setMenuBarVisibility(false)
    this.uiWindow.setMaximizable(false)
    this.uiWindow.setAlwaysOnTop(true, "pop-up-menu")

    // 阻止关闭时销毁，改为隐藏
    this.uiWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault()
        this.hideUiWindow()
      }
    })

    await this.loadRenderer(this.uiWindow, "ui")
  }

  /**
   * Check whether **any** managed window is alive (combined, avatar,
   * or UI).  Useful for `app.on("activate")` when dual mode may be active.
   */
  hasAnyWindow(): boolean {
    return (
      (this.combinedWindow !== undefined && !this.combinedWindow.isDestroyed()) ||
      (this.avatarWindow !== undefined && !this.avatarWindow.isDestroyed()) ||
      (this.uiWindow !== undefined && !this.uiWindow.isDestroyed())
    )
  }

  /** Send a raw IPC message to the avatar window (if it exists). */
  sendToAvatar(channel: string, ...args: unknown[]): void {
    this.avatarWindow?.webContents.send(channel, ...args)
  }

  /** Send a raw IPC message to the UI window (if it exists). */
  sendToUi(channel: string, ...args: unknown[]): void {
    this.uiWindow?.webContents.send(channel, ...args)
  }

  /**
   * Broadcast an AgentEvent to every open window.
   *
   * In combined mode this sends to the single window; in dual mode it
   * sends to both avatar and UI windows.  Callers can safely use this
   * instead of `sendAgentEvent` once dual windows are enabled.
   */
  broadcastAgentEvent(event: AgentEvent): void {
    const channel = IPC_CHANNELS.ON_AGENT_EVENT
    if (this.combinedWindow && !this.combinedWindow.isDestroyed()) {
      this.combinedWindow.webContents.send(channel, event)
    }
    if (this.avatarWindow && !this.avatarWindow.isDestroyed()) {
      this.avatarWindow.webContents.send(channel, event)
    }
    if (this.uiWindow && !this.uiWindow.isDestroyed()) {
      this.uiWindow.webContents.send(channel, event)
    }
  }

  /**
   * Broadcast updated PublicSettings to all open windows.
   * Used after every settings mutation so that AvatarApp / UiApp / App
   * receive the latest values without polling.
   */
  broadcastSettings(settings: PublicSettings): void {
    const channel = IPC_CHANNELS.SETTINGS_UPDATED
    if (this.combinedWindow && !this.combinedWindow.isDestroyed()) {
      this.combinedWindow.webContents.send(channel, settings)
    }
    if (this.avatarWindow && !this.avatarWindow.isDestroyed()) {
      this.avatarWindow.webContents.send(channel, settings)
    }
    if (this.uiWindow && !this.uiWindow.isDestroyed()) {
      this.uiWindow.webContents.send(channel, settings)
    }
  }

  /**
   * Broadcast a live2d:reloaded event to all windows.
   * Called when the UiApp requests a Live2D reload via invoke (LIVE2D_RELOAD).
   * The avatar window can react by bumping its reload key.
   */
  broadcastLive2DReloaded(): void {
    const channel = IPC_CHANNELS.LIVE2D_RELOADED
    if (this.combinedWindow && !this.combinedWindow.isDestroyed()) {
      this.combinedWindow.webContents.send(channel)
    }
    if (this.avatarWindow && !this.avatarWindow.isDestroyed()) {
      this.avatarWindow.webContents.send(channel)
    }
    if (this.uiWindow && !this.uiWindow.isDestroyed()) {
      this.uiWindow.webContents.send(channel)
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  Dual-window UI mode control
  // ════════════════════════════════════════════════════════════════

  /** Mark that the application is about to quit. */
  setQuitting(): void {
    this.isQuitting = true
  }

  /**
   * Show the UI window in compact input mode.
   * - Resizes to compact dimensions
   * - Positions below/near the avatar window
   * - Sends 'compact' command to renderer
   */
  showCompactInput(anchor?: CompactInputAnchor): void {
    if (!this.uiWindow || this.uiWindow.isDestroyed()) return

    // Clear any pending hide timer
    clearTimeout(this.hideTimer)

    const COMPACT_WIDTH = 420
    const COMPACT_HEIGHT = 150

    const uiPos = isCompactInputAnchor(anchor)
      ? this.positionNearScreenPoint(anchor, COMPACT_WIDTH, COMPACT_HEIGHT)
      : this.positionBelowAvatar(COMPACT_WIDTH, COMPACT_HEIGHT)

    this.uiWindow.setResizable(false)
    this.uiWindow.setSize(COMPACT_WIDTH, COMPACT_HEIGHT, false)
    this.uiWindow.setPosition(uiPos.x, uiPos.y, false)
    this.uiWindow.setSkipTaskbar(true)
    this.uiWindow.show()
    this.uiWindow.focus()
    this.keepUiAboveAvatar()

    this.uiMode = "compact"
    this.uiWindow.webContents.send(IPC_CHANNELS.WINDOW_UI_COMMAND, { mode: "compact" })
  }

  /**
   * Show the UI window in detail panel mode.
   * - Resizes to panel dimensions from settings
   * - Positions to the left (or right) of the avatar window
   * - Sends 'detail' command to renderer with tab
   */
  showDetailPanel(tab: "chat" | "settings" | "debug" = "chat"): void {
    if (!this.uiWindow || this.uiWindow.isDestroyed()) return

    // Clear any pending hide timer
    clearTimeout(this.hideTimer)

    // Record current tab for re-show after resize
    this.currentDetailTab = tab

    const display = screen.getPrimaryDisplay()
    const { width: workWidth, height: workHeight } = display.workAreaSize
    const WINDOW_GAP = 10

    // Get avatar window position
    let avatarX = 100
    let avatarY = 100
    let avatarWidth = 360
    let avatarHeight = 720
    if (this.avatarWindow && !this.avatarWindow.isDestroyed()) {
      ;[avatarX, avatarY] = this.avatarWindow.getPosition()
      ;[avatarWidth, avatarHeight] = this.avatarWindow.getContentSize()
    }

    // Use configured panel dimensions, clamped to work area
    const uiWidth = Math.min(this.panelWidth, Math.max(200, workWidth - WINDOW_GAP * 2))
    const uiHeight = Math.min(this.panelHeight, Math.max(200, workHeight - WINDOW_GAP * 2))

    // Try left of avatar first
    let uiX = avatarX - WINDOW_GAP - uiWidth
    let uiY = avatarY

    if (uiX < 0) {
      // Try right of avatar
      uiX = avatarX + avatarWidth + WINDOW_GAP
      if (uiX + uiWidth > workWidth) {
        // Neither side works, use left edge
        uiX = WINDOW_GAP
      }
    }

    // Vertically align with avatar top, but ensure it fits
    uiY = Math.max(WINDOW_GAP, Math.min(uiY, workHeight - uiHeight - WINDOW_GAP))

    this.uiWindow.setResizable(true)
    this.uiWindow.setSize(Math.round(uiWidth), Math.round(uiHeight), false)
    this.uiWindow.setPosition(Math.round(uiX), Math.round(uiY), false)
    this.uiWindow.setSkipTaskbar(false)
    this.uiWindow.show()
    this.uiWindow.focus()
    this.keepUiAboveAvatar()

    this.uiMode = "detail"
    this.uiWindow.webContents.send(IPC_CHANNELS.WINDOW_UI_COMMAND, { mode: "detail", tab })
  }

  /**
   * Hide the UI window without destroying it.
   * - Sends 'hidden' command to renderer first
   * - Hides the window
   * - Resets uiMode
   */
  hideUiWindow(): void {
    if (!this.uiWindow || this.uiWindow.isDestroyed()) return

    // Clear any pending hide timer
    clearTimeout(this.hideTimer)

    // Notify renderer before hiding
    this.uiWindow.webContents.send(IPC_CHANNELS.WINDOW_UI_COMMAND, { mode: "hidden" })

    // Small delay to allow renderer to process the command
    this.hideTimer = setTimeout(() => {
      if (this.uiWindow && !this.uiWindow.isDestroyed()) {
        this.uiWindow.hide()
      }
    }, 50)

    this.uiMode = "hidden"
  }

  /** Get the current UI mode. */
  getUiMode(): "hidden" | "compact" | "detail" {
    return this.uiMode
  }

  // ════════════════════════════════════════════════════════════════
  //  Private helpers
  // ════════════════════════════════════════════════════════════════

  /**
   * Set the panel dimensions from settings.
   */
  setPanelDimensions(width: number, height: number): void {
    this.panelWidth = clampWindowDimension(width, 460)
    this.panelHeight = clampWindowDimension(height, 760)

    // If currently in detail mode, apply new dimensions immediately
    if (this.uiMode === "detail") {
      this.showDetailPanel(this.currentDetailTab)
    }
  }

  /**
   * Calculate position for a window below the avatar, with fallback to above.
   * Returns {x, y} clamped to the work area.
   */
  private positionBelowAvatar(width: number, height: number): { x: number; y: number } {
    const display = screen.getPrimaryDisplay()
    const { width: workWidth, height: workHeight } = display.workAreaSize
    const WINDOW_GAP = 10

    let avatarX = 100
    let avatarY = 100
    let avatarWidth = 360
    let avatarHeight = 720
    if (this.avatarWindow && !this.avatarWindow.isDestroyed()) {
      ;[avatarX, avatarY] = this.avatarWindow.getPosition()
      ;[avatarWidth, avatarHeight] = this.avatarWindow.getContentSize()
    }

    // Position below avatar, centered horizontally
    let x = avatarX + Math.round((avatarWidth - width) / 2)
    let y = avatarY + avatarHeight + WINDOW_GAP

    // If below doesn't fit, try above
    if (y + height > workHeight) {
      y = avatarY - height - WINDOW_GAP
    }

    // Clamp to work area
    x = Math.max(WINDOW_GAP, Math.min(x, workWidth - width - WINDOW_GAP))
    y = Math.max(WINDOW_GAP, Math.min(y, workHeight - height - WINDOW_GAP))

    return { x, y }
  }

  /**
   * Calculate compact input position near the user's click point.
   * Prefer below the cursor, fall back above, and clamp to the current display.
   */
  private positionNearScreenPoint(anchor: CompactInputAnchor, width: number, height: number): { x: number; y: number } {
    const WINDOW_GAP = 10
    const display = screen.getDisplayNearestPoint({ x: anchor.screenX, y: anchor.screenY })
    const { x: workX, y: workY, width: workWidth, height: workHeight } = display.workArea

    const minX = workX + WINDOW_GAP
    const maxX = workX + workWidth - width - WINDOW_GAP
    const minY = workY + WINDOW_GAP
    const maxY = workY + workHeight - height - WINDOW_GAP

    let x = Math.round(anchor.screenX - width / 2)
    let y = Math.round(anchor.screenY + WINDOW_GAP)

    if (y > maxY) {
      y = Math.round(anchor.screenY - height - WINDOW_GAP)
    }

    x = Math.max(minX, Math.min(x, maxX))
    y = Math.max(minY, Math.min(y, maxY))

    return { x, y }
  }

  /**
   * Load the renderer HTML/URL into `win`, optionally with a `?window=`
   * query param that the renderer-side `getWindowRole()` will read.
   *
   * - **Development**: appends `?window=<role>` to `ELECTRON_RENDERER_URL`.
   *   DevTools are opened for the combined window only.
   * - **Production / packaged**: uses `loadFile` with `query` option.
   */
  private async loadRenderer(win: BrowserWindow, role?: WindowRole): Promise<void> {
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      let url = process.env.ELECTRON_RENDERER_URL
      if (role) {
        const separator = url.includes("?") ? "&" : "?"
        url = `${url}${separator}window=${role}`
      }
      await win.loadURL(url)
      // Open DevTools only for the combined window in dev mode
      if (!role || role === "combined") {
        win.webContents.openDevTools({ mode: "detach" })
      }
    } else {
      // Packaged / production — pass query via Electron's loadFile API
      const query = role ? { window: role } : undefined
      await win.loadFile(join(currentDir, "../renderer/index.html"), { query })
    }

    // Prevent drag-and-drop files from opening new windows / navigating
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", (event, url) => {
      // Allow only app-internal URLs (dev server or file:// index.html)
      const isAppUrl =
        url.startsWith("file://") ||
        (isDev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
      if (!isAppUrl) {
        event.preventDefault()
      }
    })
  }

  private lockCurrentWindowSize(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const [width, height] = win.getSize()
    this.lockedSize = { width, height }
    win.setMinimumSize(width, height)
    win.setMaximumSize(width, height)
  }

  private lockWindowContentSize(role: WindowRole, win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    this.lockedContentSizes.set(role, { width, height })
    // Lock frame bounds too (frameless windows: bounds ≅ content size).
    const bounds = win.getBounds()
    win.setMinimumSize(bounds.width, bounds.height)
    win.setMaximumSize(bounds.width, bounds.height)
  }

  private restoreWindowContentSize(role: WindowRole, win: BrowserWindow): void {
    const locked = this.lockedContentSizes.get(role)
    if (!locked || win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    if (width === locked.width && height === locked.height) return
    win.setContentSize(locked.width, locked.height, false)
  }

  private restoreLockedSize(win?: BrowserWindow): void {
    const target = win ?? this.combinedWindow
    if (!target || target.isDestroyed() || !this.lockedSize) return
    const bounds = target.getBounds()
    if (bounds.width === this.lockedSize.width && bounds.height === this.lockedSize.height) return
    target.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: this.lockedSize.width,
      height: this.lockedSize.height,
    }, false)
  }
}

function isCompactInputAnchor(value: unknown): value is CompactInputAnchor {
  if (!value || typeof value !== "object") return false
  const anchor = value as Partial<CompactInputAnchor>
  return Number.isFinite(anchor.screenX) && Number.isFinite(anchor.screenY)
}

function clampWindowDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(4000, Math.max(200, value)))
}
