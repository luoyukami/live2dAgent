/** IPC channel names for typed communication between Main / Preload / Renderer */
export const IPC_CHANNELS = {
  /** User sends a message to the agent */
  SEND_USER_MESSAGE: "agent:send-user-message",
  /** User approves a pending tool action */
  APPROVE_ACTION: "agent:approve-action",
  /** User denies a pending tool action */
  DENY_ACTION: "agent:deny-action",
  /** Clear visible messages and reset the active agent context */
  CLEAR_CONTEXT: "agent:clear-context",
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

  /* ---- Audio (voice input) ---- */
  AUDIO_SAVE_RECORDING: "audio:save-recording",
  AUDIO_OPEN_FOLDER: "audio:open-folder",
  VOICE_DEBUG_UPDATE: "audio:voice-debug-update",

  /* ---- Settings channels (Phase 1) ---- */
  SETTINGS_GET: "settings:get",
  SETTINGS_UPDATE_PUBLIC: "settings:update-public",
  SETTINGS_UPDATE_API_KEY: "settings:update-api-key",
  SETTINGS_UPDATE_WORKSPACE: "settings:update-workspace",
  SETTINGS_UPDATE_LIVE2D_MODEL_PATH: "settings:update-live2d-path",

  /* ---- Window controls ---- */
  WINDOW_MOVE_BY: "window:move-by",
  WINDOW_DRAG_START: "window:drag-start",
  WINDOW_DRAG_END: "window:drag-end",
  WINDOW_SET_MOUSE_PASSTHROUGH: "window:set-mouse-passthrough",
  WINDOW_SET_AVATAR_HIT_REGION: "window:set-avatar-hit-region",

  /* ---- Dual-window UI control ---- */
  WINDOW_SHOW_COMPACT_INPUT: "window:show-compact-input",
  WINDOW_SHOW_DETAIL_PANEL: "window:show-detail-panel",
  WINDOW_HIDE_UI: "window:hide-ui",
  WINDOW_UI_COMMAND: "window:ui-command",

  /* ---- Debug / Trace / Manual Action (Phase 2) ---- */
  DEBUG_GET_SNAPSHOT: "debug:get-snapshot",
  TRACE_GET_EVENTS: "trace:get-events",
  TRACE_APPEND: "trace:append",
  TRACE_OPEN_FOLDER: "trace:open-folder",
  ARTIFACT_OPEN_FOLDER: "artifact:open-folder",
  PROMPT_OPEN_FOLDER: "prompt:open-folder",
  SETTINGS_RELOAD: "settings:reload",
  PROMPT_RELOAD: "prompt:reload",
  LIVE2D_RELOAD: "live2d:reload",
  LIVE2D_RELOADED: "live2d:reloaded",
  MANUAL_ACTION_RUN: "manual-action:run",

  /* ---- Settings broadcast (Phase 5) ---- */
  SETTINGS_UPDATED: "settings:updated",

  /* ---- TTS ---- */
  TTS_HEALTH_CHECK: "tts:health-check",
  TTS_LIST_VOICES: "tts:list-voices",
  TTS_REGISTER_VOICE: "tts:register-voice",
  TTS_RENAME_VOICE: "tts:rename-voice",
  TTS_DELETE_VOICE: "tts:delete-voice",
  TTS_GENERATE: "tts:generate",
  TTS_PLAY_AUDIO: "tts:play-audio",
  TTS_STOP_AUDIO: "tts:stop-audio",
  TTS_GET_SETTINGS: "tts:get-settings",
  TTS_UPDATE_SETTINGS: "tts:update-settings",
  TTS_OPEN_AUDIO_FOLDER: "tts:open-audio-folder",
  TTS_SELECT_AUDIO_DIR: "tts:select-audio-dir",
} as const

/** Default workspace-relative paths for trace and screenshot storage */
export const DEFAULT_PATHS = {
  TRACES_DIR: "traces",
  SCREENSHOTS_DIR: "screenshots",
  SETTINGS_FILE: "settings.json",
  LATEST_TRACE: "traces/latest.jsonl",
} as const
