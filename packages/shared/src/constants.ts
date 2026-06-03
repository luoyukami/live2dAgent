/** IPC channel names for typed communication between Main / Preload / Renderer */
export const IPC_CHANNELS = {
  /** User sends a message to the agent */
  SEND_USER_MESSAGE: "agent:send-user-message",
  /** User approves a pending tool action */
  APPROVE_ACTION: "agent:approve-action",
  /** User denies a pending tool action */
  DENY_ACTION: "agent:deny-action",
  /** Change agent mode (manual / confirm / auto) */
  SET_AGENT_MODE: "agent:set-mode",
  /** Subscribe to agent events from renderer */
  ON_AGENT_EVENT: "agent:on-event",

  /* ---- Tool execution channels ---- */
  SCREENSHOT_CAPTURE: "tool:screenshot-capture",
  SHELL_RUN: "tool:shell-run",
  FILE_READ: "tool:file-read",
  FILE_WRITE: "tool:file-write",
  CLIPBOARD_READ: "tool:clipboard-read",
  CLIPBOARD_WRITE: "tool:clipboard-write",
} as const

/** Default workspace-relative paths for trace and screenshot storage */
export const DEFAULT_PATHS = {
  TRACES_DIR: "traces",
  SCREENSHOTS_DIR: "screenshots",
  SETTINGS_FILE: "settings.json",
  LATEST_TRACE: "traces/latest.jsonl",
} as const
