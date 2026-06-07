/**
 * Context types for ContextManager — token budget, artifact TTL, model input building.
 *
 * These types are runtime-agnostic (no Electron / Node / React dependencies).
 */
import type { RuntimeErrorPayload } from "../ws/ws-types.js"

/* ------------------------------------------------------------------ */
/*  Artifact types                                                      */
/* ------------------------------------------------------------------ */

export type ArtifactType = "image" | "audio" | "tool_output" | "file"

/**
 * An artifact entry that may contain raw data or just a reference/summary
 * (subject to TTL and size limits).
 */
export interface ArtifactEntry {
  id: string
  type: ArtifactType
  mimeType?: string
  /** The raw base64 data (omitted for expired artifacts). */
  rawData?: string
  /** Human-readable reference/summary when raw data is not included. */
  reference: string
  /** When this artifact was created (epoch ms). */
  createdAt: number
  /** The turn index when this artifact was added. */
  turnIndex: number
  /** Size in bytes of the raw data (0 for reference-only). */
  size: number
}

/* ------------------------------------------------------------------ */
/*  ContextManager input                                                */
/* ------------------------------------------------------------------ */

export interface ContextManagerInput {
  /** System instructions for the model. */
  systemInstructions: string
  /** Current user message text. */
  currentUserMessage: string
  /** Recent conversation messages (with createdAt for windowing). */
  conversationMessages: Array<{
    id: string
    role: "user" | "assistant"
    content: string
    createdAt: number
  }>
  /**
   * Tool results from the current run.
   * Uses the already-truncated contentForModel (ToolOutputTruncator handles
   * the actual truncation; ContextManager just passes it through).
   */
  toolResults: Array<{
    toolCallId: string
    toolName: string
    status: string
    summary: string
    contentForModel: string
    artifactRef?: string
  }>
  /** Optional conversation summary (from summarization). */
  conversationSummary?: string
  /** Raw artifacts from the current turn (images, audio, etc.). */
  currentArtifacts: ArtifactEntry[]
  /** Historical artifacts from previous turns (subject to TTL). */
  historicalArtifacts: ArtifactEntry[]
  /** Tool schemas to include in the model input. */
  toolSchemas: Array<{
    name: string
    description?: string
    inputSchema?: unknown
  }>
  /** Current turn index for TTL calculation. */
  currentTurnIndex: number
}

/* ------------------------------------------------------------------ */
/*  ModelInput — what the ContextManager produces                       */
/* ------------------------------------------------------------------ */

export interface ModelInput {
  /** Messages ready to send to the model. */
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool"
    content: string
  }>
  /** Token estimate for the input. */
  tokenEstimate: number
  /** Whether truncation was applied (soft limit triggered). */
  truncated: boolean
  /** Artifacts that were included as raw data in this request. */
  includedArtifacts: ArtifactEntry[]
  /** Artifacts that were referenced only (not raw). */
  referencedArtifacts: ArtifactEntry[]
  /** Error if hard limit was exceeded (caller must check). */
  error?: RuntimeErrorPayload
}

/* ------------------------------------------------------------------ */
/*  ContextManager options                                              */
/* ------------------------------------------------------------------ */

export interface ContextManagerOptions {
  /** Soft token limit — below this, send full window. Default: 48000. */
  softTokenLimit?: number
  /** Hard token limit — above this, refuse the request. Default: 64000. */
  hardTokenLimit?: number
  /** Tokens reserved for model output (subtracted from limits). Default: 8000. */
  reservedOutputTokens?: number
  /** Max recent text messages to include normally. Default: 16. */
  maxRecentTextMessages?: number
  /** Max recent messages when soft limit is exceeded. Default: 8. */
  maxRecentMessagesOnSoftLimit?: number
  /** Turns after which raw image data is replaced with reference. Default: 1. */
  rawImageTtlTurns?: number
  /** Turns after which raw audio data is replaced with reference. Default: 1. */
  rawAudioTtlTurns?: number
  /** Max total bytes of raw artifact data per single request. Default: 12MB. */
  maxRawArtifactBytes?: number
}

/* ------------------------------------------------------------------ */
/*  Default constants (mirrors ws-runtime-constants.ts)                 */
/* ------------------------------------------------------------------ */

export const DEFAULT_CONTEXT_OPTIONS: Required<ContextManagerOptions> = {
  softTokenLimit: 48_000,
  hardTokenLimit: 64_000,
  reservedOutputTokens: 8_000,
  maxRecentTextMessages: 16,
  maxRecentMessagesOnSoftLimit: 8,
  rawImageTtlTurns: 1,
  rawAudioTtlTurns: 1,
  maxRawArtifactBytes: 12 * 1024 * 1024, // 12 MB
}
