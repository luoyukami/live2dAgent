/**
 * Fixed runtime constants for the WS-based model communication layer.
 *
 * All values are hard-coded for this phase — no configuration surface.
 * See docs/ws_model_communication_architecture.md §5.
 */
export const WS_RUNTIME_CONSTANTS = {
  /** WS idle timeout in ms (240s). */
  IDLE_CLOSE_MS: 240_000,

  /** Heartbeat ping interval in ms (30s). */
  HEARTBEAT_INTERVAL_MS: 30_000,

  /** Time to wait for a pong after ping before considering the connection dead. */
  PONG_TIMEOUT_MS: 12_000,

  /** Connection establishment timeout in ms. */
  CONNECT_TIMEOUT_MS: 10_000,

  /** Graceful close timeout in ms. */
  CLOSE_TIMEOUT_MS: 3_000,

  /** Delay sequence between reconnect attempts (ms). */
  RECONNECT_DELAYS_MS: [500, 1_000, 2_000, 4_000, 8_000],

  /** Maximum number of reconnect attempts before giving up. */
  MAX_RECONNECT_ATTEMPTS: 5,

  /** Only one active run per conversation at a time. */
  MAX_ACTIVE_RUNS_PER_CONVERSATION: 1,

  /** Max queued user messages per conversation. */
  MAX_QUEUED_USER_MESSAGES_PER_CONVERSATION: 8,

  /** Max tool calls in a single run. */
  MAX_TOOL_CALLS_PER_RUN: 12,

  /** Max model continuations (tool-result → model turns) per run. */
  MAX_MODEL_CONTINUATIONS_PER_RUN: 16,

  /** Single tool execution timeout in ms. */
  TOOL_EXECUTION_TIMEOUT_MS: 60_000,

  /** Max chars of tool result inlined directly into model input. */
  TOOL_RESULT_INLINE_CHAR_LIMIT: 8_000,

  /** Max chars of tool result summary sent to model. */
  TOOL_RESULT_SUMMARY_CHAR_LIMIT: 1_200,

  /** Chars from the head of a truncated tool result to include in the model output. */
  TOOL_RESULT_HEAD_CHARS: 3_000,

  /** Chars from the tail of a truncated tool result to include in the model output. */
  TOOL_RESULT_TAIL_CHARS: 3_000,

  /**
   * Doom-loop detection threshold: same tool + identical args N times in a row
   * is allowed; the (N+1)-th call is blocked.
   */
  DOOM_LOOP_THRESHOLD: 3,

  /** How often (ms) to flush accumulated assistant delta to conversation & IPC. */
  ASSISTANT_DELTA_FLUSH_INTERVAL_MS: 50,

  /** Force-flush assistant delta when accumulated chars reach this threshold. */
  ASSISTANT_DELTA_FORCE_FLUSH_CHARS: 512,

  /** Soft token limit — below this, send full window. */
  REQUEST_INPUT_SOFT_TOKEN_LIMIT: 48_000,

  /** Hard token limit — above this, refuse the request. */
  REQUEST_INPUT_HARD_TOKEN_LIMIT: 64_000,

  /** Tokens reserved for model output. */
  RESERVED_OUTPUT_TOKENS: 8_000,

  /** Raw image is included in model input for this many turns after upload. */
  RAW_IMAGE_SEND_TTL_TURNS: 1,

  /** Raw audio is included in model input for this many turns after recording. */
  RAW_AUDIO_SEND_TTL_TURNS: 1,

  /** Maximum total bytes of raw artifact (image, audio) per single request. */
  MAX_RAW_ARTIFACT_BYTES_PER_REQUEST: 12 * 1024 * 1024,
} as const
