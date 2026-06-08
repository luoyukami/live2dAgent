import { BrowserWindow, screen } from "electron"
import { join } from "node:path"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type { PublicSettings, UiSettings } from "@live2d-agent/shared"

const isDev = process.env.NODE_ENV === "development"

type WindowRole = "avatar" | "ui" | "combined"

export class WindowManager {
  /** Single-window (combined) mode — the default behaviour. */
  private combinedWindow?: BrowserWindow

  /** Dual-window mode — dedicated avatar / UI windows. */
  private avatarWindow?: BrowserWindow
  private uiWindow?: BrowserWindow

  /** Drag state for the combined window (single-window mode). */
  private dragTimer?: NodeJS.Timeout
  private dragStart?: { cursorX: number; cursorY: number; windowX: number; windowY: number }
  private lockedSize?: { width: number; height: number }

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
        preload: join(__dirname, "../preload/index.js"),
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

  startDrag(): void {
    if (!this.combinedWindow || this.combinedWindow.isDestroyed()) return
    this.endDrag()
    const cursor = screen.getCursorScreenPoint()
    const [windowX, windowY] = this.combinedWindow.getPosition()
    this.dragStart = { cursorX: cursor.x, cursorY: cursor.y, windowX, windowY }
    this.dragTimer = setInterval(() => this.updateDragPosition(), 16)
  }

  endDrag(): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = undefined
    }
    this.dragStart = undefined
  }

  private updateDragPosition(): void {
    if (!this.combinedWindow || this.combinedWindow.isDestroyed() || !this.dragStart) {
      this.endDrag()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    this.combinedWindow.setPosition(
      Math.round(this.dragStart.windowX + cursor.x - this.dragStart.cursorX),
      Math.round(this.dragStart.windowY + cursor.y - this.dragStart.cursorY),
      false,
    )
    this.restoreLockedSize(this.combinedWindow)
  }

  setMousePassthrough(enabled: boolean): void {
    if (!this.combinedWindow || this.combinedWindow.isDestroyed()) return
    this.combinedWindow.setIgnoreMouseEvents(enabled, { forward: true })
  }

  // ════════════════════════════════════════════════════════════════
  //  Dual-window mode — default startup (Phase 5+)
  // ════════════════════════════════════════════════════════════════

  /**
   * Create separate avatar + UI windows.
   *
   * - **Avatar window**: transparent, frameless, always-on-top, skip taskbar,
   *   non-interactive (click-through).  Loads renderer with `?window=avatar`.
   * - **UI window**: standard interactive window (no transparency, resizable,
   *   always-on-top).  Loads renderer with `?window=ui`.
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
        preload: join(__dirname, "../preload/index.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.avatarWindow.setMenuBarVisibility(false)
    this.avatarWindow.setMaximizable(false)
    // Avatar window is non-interactive: clicks pass through to desktop
    this.avatarWindow.setIgnoreMouseEvents(true, { forward: true })
    await this.loadRenderer(this.avatarWindow, "avatar")

    // ── UI window ───────────────────────────────────────────────
    // Use persisted panel dimensions, clamped to the work area.
    const WINDOW_GAP = 10

    const uiWidth = Math.min(clampWindowDimension(ui?.panelWidth, 460), Math.max(200, workWidth - WINDOW_GAP * 2))
    const uiHeight = Math.min(clampWindowDimension(ui?.panelHeight, 760), Math.max(200, workHeight - WINDOW_GAP * 2))

    // Prefer positioning the UI window to the left of the avatar window
    // with a small gap, so the two windows do not overlap.
    const avatarX = Math.max(0, workWidth - avatarWidth - 20)

    let uiX = avatarX - WINDOW_GAP - uiWidth
    if (uiX < 0) {
      // Not enough room on the left — try right of the avatar instead.
      uiX = avatarX + avatarWidth + WINDOW_GAP
      if (uiX + uiWidth > workWidth) {
        // Neither side works — place at the left edge of the work area.
        uiX = WINDOW_GAP
      }
    }

    // Vertically align the UI window bottom with the work area.
    const uiY = Math.max(WINDOW_GAP, workHeight - uiHeight - 20)

    this.uiWindow = new BrowserWindow({
      width: Math.round(uiWidth),
      height: Math.round(uiHeight),
      useContentSize: true,
      x: Math.round(uiX),
      y: Math.round(uiY),
      transparent: false,
      frame: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.uiWindow.setMenuBarVisibility(false)
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
  //  Private helpers
  // ════════════════════════════════════════════════════════════════

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
      return
    }

    // Packaged / production — pass query via Electron's loadFile API
    const query = role ? { window: role } : undefined
    await win.loadFile(join(__dirname, "../renderer/index.html"), { query })
  }

  private lockCurrentWindowSize(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const [width, height] = win.getSize()
    this.lockedSize = { width, height }
    win.setMinimumSize(width, height)
    win.setMaximumSize(width, height)
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

function clampWindowDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(4000, Math.max(200, value)))
}
