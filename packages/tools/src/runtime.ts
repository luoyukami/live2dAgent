/**
 * RuntimeToolContext — capability functions injected by the host environment
 * (e.g. Electron main process).
 *
 * The tools package never calls these directly; it only defines the shape.
 * The actual dangerous I/O is performed by the context implementation,
 * keeping the tool definitions pure and testable.
 */
export interface RuntimeToolContext {
  /** Execute a shell command. Returns stdout, stderr, and exit code. */
  runShell: (
    command: string,
    cwd?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>

  /** Read a file as a UTF-8 string (must be inside workspace). */
  readFile: (path: string) => Promise<string>

  /** Write a UTF-8 string to a file (must be inside workspace). */
  writeFile: (path: string, content: string) => Promise<void>

  /** Read text from the system clipboard. */
  readClipboard: () => Promise<string>

  /** Write text to the system clipboard. */
  writeClipboard: (text: string) => Promise<void>

  /** Capture a screenshot (optionally targeting a specific display). */
  captureScreenshot: (
    displayId?: string,
  ) => Promise<{ imageBase64: string; mimeType: string }>

  /** Signal that the current task is complete. */
  finishTask: (
    summary: string,
    status: "success" | "failed" | "cancelled",
  ) => Promise<void>
}
