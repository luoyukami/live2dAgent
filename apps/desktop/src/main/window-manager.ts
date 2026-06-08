import { BrowserWindow, screen } from "electron"
import { join } from "node:path"
import { IPC_CHANNELS } from "@live2d-agent/shared"
import type { AgentEvent } from "@live2d-agent/agent-core"
import type { UiSettings } from "@live2d-agent/shared"

const isDev = process.env.NODE_ENV === "development"

export class WindowManager {
  private win?: BrowserWindow
  private dragTimer?: NodeJS.Timeout
  private dragStart?: { cursorX: number; cursorY: number; windowX: number; windowY: number }
  private lockedSize?: { width: number; height: number }

  async create(ui?: Pick<UiSettings, "width" | "height">): Promise<void> {
    const display = screen.getPrimaryDisplay()
    const { width: workWidth, height: workHeight } = display.workAreaSize
    const windowWidth = clampWindowDimension(ui?.width, 360)
    const windowHeight = clampWindowDimension(ui?.height, 720)

    this.win = new BrowserWindow({
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

    this.win.setMenuBarVisibility(false)
    this.win.setMaximizable(false)
    this.lockCurrentWindowSize()

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      await this.win.loadURL(process.env.ELECTRON_RENDERER_URL)
      this.win.webContents.openDevTools({ mode: "detach" })
      return
    }

    await this.win.loadFile(join(__dirname, "../renderer/index.html"))
  }

  hasWindow(): boolean {
    return !this.win?.isDestroyed()
  }

  sendAgentEvent(event: AgentEvent): void {
    this.win?.webContents.send(IPC_CHANNELS.ON_AGENT_EVENT, event)
  }

  setSize(width: number, height: number): void {
    if (!this.win || this.win.isDestroyed()) return
    const nextWidth = clampWindowDimension(width, 360)
    const nextHeight = clampWindowDimension(height, 720)
    this.win.setMinimumSize(200, 200)
    this.win.setMaximumSize(4000, 4000)
    this.win.setContentSize(nextWidth, nextHeight, false)
    this.lockCurrentWindowSize()
  }

  moveBy(dx: number, dy: number): void {
    if (!this.win || this.win.isDestroyed()) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = this.win.getPosition()
    this.win.setPosition(Math.round(x + dx), Math.round(y + dy), false)
    this.restoreLockedSize()
  }

  startDrag(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.endDrag()
    const cursor = screen.getCursorScreenPoint()
    const [windowX, windowY] = this.win.getPosition()
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
    if (!this.win || this.win.isDestroyed() || !this.dragStart) {
      this.endDrag()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    this.win.setPosition(
      Math.round(this.dragStart.windowX + cursor.x - this.dragStart.cursorX),
      Math.round(this.dragStart.windowY + cursor.y - this.dragStart.cursorY),
      false,
    )
    this.restoreLockedSize()
  }

  setMousePassthrough(enabled: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.setIgnoreMouseEvents(enabled, { forward: true })
  }

  private lockCurrentWindowSize(): void {
    if (!this.win || this.win.isDestroyed()) return
    const [width, height] = this.win.getSize()
    this.lockedSize = { width, height }
    this.win.setMinimumSize(width, height)
    this.win.setMaximumSize(width, height)
  }

  private restoreLockedSize(): void {
    if (!this.win || this.win.isDestroyed() || !this.lockedSize) return
    const bounds = this.win.getBounds()
    if (bounds.width === this.lockedSize.width && bounds.height === this.lockedSize.height) return
    this.win.setBounds({
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
