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

  /* ---- Settings channels (Phase 1) ---- */
  SETTINGS_GET: "settings:get",
  SETTINGS_UPDATE_PUBLIC: "settings:update-public",
  SETTINGS_UPDATE_API_KEY: "settings:update-api-key",
  SETTINGS_UPDATE_WORKSPACE: "settings:update-workspace",
  SETTINGS_UPDATE_LIVE2D_MODEL_PATH: "settings:update-live2d-path",
} as const

/** Default workspace-relative paths for trace and screenshot storage */
export const DEFAULT_PATHS = {
  TRACES_DIR: "traces",
  SCREENSHOTS_DIR: "screenshots",
  SETTINGS_FILE: "settings.json",
  LATEST_TRACE: "traces/latest.jsonl",
} as const
