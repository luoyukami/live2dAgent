/**
 * ContextManager — builds model input with token budgeting, artifact TTL,
 * and raw artifact size enforcement.
 *
 * Responsibilities:
 *   1. Construct ModelInput from ContextManagerInput
 *   2. Apply artifact TTL (raw images/audio only sent for 1 turn by default)
 *   3. Enforce raw artifact size limit (12MB by default)
 *   4. Apply token budget window (soft 48k / hard 64k)
 *      - <= 48k: normal (all recent messages)
 *      - 48k-64k: drop older text messages, keep summary + current user + last 8 + tool results
 *      - > 64k: return ModelInput with context_hard_limit_exceeded error
 *   5. Provide DefaultContextManager as a simple pass-through fallback
 *
 * See docs/ws_model_communication_architecture.md §16.
 */
import { RuntimeErrors } from "../ws/ws-errors.js"
import type { RuntimeErrorPayload } from "../ws/ws-types.js"
import { estimateMessageTokens } from "./token-budget.js"
import {
  type ArtifactEntry,
  type ContextManagerInput,
  type ContextManagerOptions,
  type ModelInput,
  DEFAULT_CONTEXT_OPTIONS,
} from "./context-types.js"

export type { ContextManagerInput, ContextManagerOptions, ModelInput, ArtifactEntry } from "./context-types.js"
export { estimateTokens, estimateMessageTokens } from "./token-budget.js"

/* ------------------------------------------------------------------ */
/*  ContextManager                                                      */
/* ------------------------------------------------------------------ */

export class ContextManager {
  protected opts: Required<ContextManagerOptions>

  constructor(options?: ContextManagerOptions) {
    this.opts = { ...DEFAULT_CONTEXT_OPTIONS, ...options }
  }

  /**
   * Build a ModelInput from raw conversation state.
   *
   * Steps:
   *   1. Resolve artifact TTL — decide which artifacts are raw vs reference-only.
   *   2. Apply max raw artifact bytes — if exceeded, keep only latest raw.
   *   3. Build the initial message array (system, summary, recent text, current user, tool results).
   *   4. Estimate tokens.
   *   5. If within soft limit → return as-is.
   *   6. If between soft and hard → drop older text messages, keep summary + current + last N + tool results.
   *   7. If exceeds hard limit → return with context_hard_limit_exceeded error.
   */
  build(input: ContextManagerInput): ModelInput {
    // 1 & 2. Apply artifact TTL and size limits
    const { includedArtifacts, referencedArtifacts } = this.resolveArtifacts(
      input.currentArtifacts,
      input.historicalArtifacts,
      input.currentTurnIndex,
    )

    // 3. Build messages
    const messages = this.buildMessages(input, includedArtifacts, referencedArtifacts)

    // 4. Estimate tokens
    let tokenEstimate = estimateMessageTokens(messages)
    let truncated = false

    // 5-7. Apply token budget
    const effectiveSoftLimit = this.opts.softTokenLimit - this.opts.reservedOutputTokens
    const effectiveHardLimit = this.opts.hardTokenLimit - this.opts.reservedOutputTokens

    if (tokenEstimate <= effectiveSoftLimit) {
      // Normal case — return as-is
      return {
        messages,
        tokenEstimate,
        truncated: false,
        includedArtifacts,
        referencedArtifacts,
      }
    }

    if (tokenEstimate <= effectiveHardLimit) {
      // Soft limit exceeded — drop older text messages, keep summary + current + last N + tool results
      const trimmedMessages = this.applySoftLimit(input, includedArtifacts)
      tokenEstimate = estimateMessageTokens(trimmedMessages)
      truncated = true

      // If after trimming we still exceed soft limit but are under hard limit, accept it
      return {
        messages: trimmedMessages,
        tokenEstimate,
        truncated: true,
        includedArtifacts,
        referencedArtifacts,
      }
    }

    // Hard limit exceeded
    return {
      messages,
      tokenEstimate,
      truncated: false,
      includedArtifacts,
      referencedArtifacts,
      error: RuntimeErrors.contextHardLimitExceeded(),
    }
  }

  /* ---- Internal: artifact resolution ---- */

  /**
   * Resolve which artifacts are included as raw data vs reference-only.
   *
   * Rules:
   *   - Raw images exceed TTL (rawImageTtlTurns) → reference-only
   *   - Raw audio exceeds TTL (rawAudioTtlTurns) → reference-only
   *   - Total raw artifact bytes > maxRawArtifactBytes → keep only the latest raw,
   *     rest become reference-only
   */
  private resolveArtifacts(
    currentArtifacts: ArtifactEntry[],
    historicalArtifacts: ArtifactEntry[],
    currentTurnIndex: number,
  ): { includedArtifacts: ArtifactEntry[]; referencedArtifacts: ArtifactEntry[] } {
    const allArtifacts = [...currentArtifacts, ...historicalArtifacts]
    const includedArtifacts: ArtifactEntry[] = []
    const referencedArtifacts: ArtifactEntry[] = []

    // Phase 1: Apply TTL — decide raw vs reference for each artifact
    const ttlDecided: Array<{ entry: ArtifactEntry; isRaw: boolean }> = []
    for (const entry of allArtifacts) {
      const turnsAgo = currentTurnIndex - entry.turnIndex
      const ttl = entry.type === "image" ? this.opts.rawImageTtlTurns
        : entry.type === "audio" ? this.opts.rawAudioTtlTurns
        : 0 // non-image/audio artifacts have no TTL

      // If rawData is absent, it's already reference-only
      const hasData = !!entry.rawData && entry.size > 0
      if (!hasData) {
        ttlDecided.push({ entry, isRaw: false })
        continue
      }

      if (ttl >= 0 && turnsAgo > ttl) {
        // Exceeded TTL — reference only (strip raw data)
        ttlDecided.push({ entry: { ...entry, rawData: undefined }, isRaw: false })
      } else {
        ttlDecided.push({ entry, isRaw: true })
      }
    }

    // Phase 2: Apply max raw bytes
    // Collect all entries that should be raw (after TTL)
    let rawCandidates = ttlDecided.filter((d) => d.isRaw)
    const rawTotalBytes = rawCandidates.reduce((sum, d) => sum + d.entry.size, 0)

    if (rawTotalBytes > this.opts.maxRawArtifactBytes) {
      // Sort by turnIndex descending (latest first), keep newest raw, rest reference
      rawCandidates.sort((a, b) => b.entry.turnIndex - a.entry.turnIndex)
      let accumulated = 0
      const allowedRaw: typeof rawCandidates = []
      const deniedRaw: typeof rawCandidates = []
      let atLeastOneAllowed = false
      for (const candidate of rawCandidates) {
        if (accumulated + candidate.entry.size <= this.opts.maxRawArtifactBytes || (!atLeastOneAllowed && allowedRaw.length === 0)) {
          allowedRaw.push(candidate)
          accumulated += candidate.entry.size
          atLeastOneAllowed = true
        } else {
          deniedRaw.push(candidate)
        }
      }
      // Rebuild: allowedRaw stay raw, deniedRaw become reference
      for (const d of ttlDecided) {
        if (d.isRaw) {
          const inAllowed = allowedRaw.some((a) => a.entry.id === d.entry.id)
          if (inAllowed) {
            includedArtifacts.push(d.entry)
          } else {
            referencedArtifacts.push(d.entry)
          }
        } else {
          referencedArtifacts.push(d.entry)
        }
      }
    } else {
      // All raw candidates fit
      for (const d of ttlDecided) {
        if (d.isRaw) {
          includedArtifacts.push(d.entry)
        } else {
          referencedArtifacts.push(d.entry)
        }
      }
    }

    return { includedArtifacts, referencedArtifacts }
  }

  /* ---- Internal: message building ---- */

  /**
   * Build the full message array from input.
   */
  private buildMessages(
    input: ContextManagerInput,
    includedArtifacts: ArtifactEntry[],
    referencedArtifacts?: ArtifactEntry[],
  ): Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = []

    // System instructions
    if (input.systemInstructions) {
      messages.push({ role: "system", content: input.systemInstructions })
    }

    // Conversation summary (if available)
    if (input.conversationSummary) {
      messages.push({
        role: "system",
        content: `[Conversation Summary]\n${input.conversationSummary}`,
      })
    }

    // Recent conversation messages (up to maxRecentTextMessages)
    const recentMessages = input.conversationMessages.slice(-this.opts.maxRecentTextMessages)
    for (const msg of recentMessages) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    // Current user message
    if (input.currentUserMessage) {
      messages.push({ role: "user", content: input.currentUserMessage })
    }

    // Artifact references — add as user messages with descriptive content
    // Raw artifacts are included inline; referenced artifacts get a text note
    for (const art of includedArtifacts) {
      if (art.type === "image") {
        messages.push({
          role: "user",
          content: `[Image: ${art.reference}] (raw data included)`,
        })
      } else if (art.type === "audio") {
        messages.push({
          role: "user",
          content: `[Audio: ${art.reference}] (raw data included)`,
        })
      } else {
        messages.push({
          role: "user",
          content: `[Artifact: ${art.reference}]`,
        })
      }
    }
    for (const art of referencedArtifacts ?? []) {
      messages.push({
        role: "user",
        content: `[Artifact Reference: ${art.id} — ${art.reference}]`,
      })
    }

    // Tool results from current run (already truncated by ToolOutputTruncator)
    for (const tr of input.toolResults) {
      messages.push({
        role: "tool",
        content: tr.contentForModel,
      })
    }

    return messages
  }

  /**
   * Apply soft limit: drop older conversation messages, keep only:
   *   - system instructions
   *   - summary
   *   - current user message
   *   - last N (maxRecentMessagesOnSoftLimit) text messages
   *   - current tool results
   *   - artifact references
   */
  private applySoftLimit(
    input: ContextManagerInput,
    includedArtifacts: ArtifactEntry[],
  ): Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = []

    // System instructions
    if (input.systemInstructions) {
      messages.push({ role: "system", content: input.systemInstructions })
    }

    // Summary
    if (input.conversationSummary) {
      messages.push({
        role: "system",
        content: `[Conversation Summary]\n${input.conversationSummary}`,
      })
    }

    // Only last N text messages
    const recentMessages = input.conversationMessages.slice(-this.opts.maxRecentMessagesOnSoftLimit)
    for (const msg of recentMessages) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    // Current user message
    if (input.currentUserMessage) {
      messages.push({ role: "user", content: input.currentUserMessage })
    }

    // Artifact references
    for (const art of includedArtifacts) {
      messages.push({
        role: "user",
        content: `[Artifact: ${art.type} — ${art.reference}]`,
      })
    }
    const refResult = this.resolveArtifacts(
      input.currentArtifacts,
      input.historicalArtifacts,
      input.currentTurnIndex,
    )
    for (const art of refResult.referencedArtifacts) {
      messages.push({
        role: "user",
        content: `[Artifact Reference: ${art.id} — ${art.reference}]`,
      })
    }

    // Tool results
    for (const tr of input.toolResults) {
      messages.push({
        role: "tool",
        content: tr.contentForModel,
      })
    }

    return messages
  }
}

/* ------------------------------------------------------------------ */
/*  DefaultContextManager — simple pass-through fallback                */
/* ------------------------------------------------------------------ */

/**
 * A minimal ContextManager that passes through messages as-is without
 * token budgeting, artifact TTL, or size enforcement.
 *
 * Used as the default when RunController does not receive a custom
 * ContextManager. This ensures backward compatibility.
 */
export class DefaultContextManager extends ContextManager {
  constructor() {
    // Use very large limits so nothing gets trimmed
    super({
      softTokenLimit: 1_000_000,
      hardTokenLimit: 2_000_000,
      maxRecentTextMessages: 1_000,
      maxRecentMessagesOnSoftLimit: 1_000,
      rawImageTtlTurns: 100,
      rawAudioTtlTurns: 100,
      maxRawArtifactBytes: 1_000_000_000, // ~1GB
    })
  }

  /**
   * Simple pass-through: format messages without token enforcement.
   * Only applies basic artifact TTL to avoid sending stale raw data.
   */
  override build(input: ContextManagerInput): ModelInput {
    const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = []

    // System
    if (input.systemInstructions) {
      messages.push({ role: "system", content: input.systemInstructions })
    }

    // Summary
    if (input.conversationSummary) {
      messages.push({ role: "system", content: `[Conversation Summary]\n${input.conversationSummary}` })
    }

    // All conversation messages (no limit)
    for (const msg of input.conversationMessages) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    // Current user message
    if (input.currentUserMessage) {
      messages.push({ role: "user", content: input.currentUserMessage })
    }

    // Tool results
    for (const tr of input.toolResults) {
      messages.push({ role: "tool", content: tr.contentForModel })
    }

    const tokenEstimate = estimateMessageTokens(messages)

    return {
      messages,
      tokenEstimate,
      truncated: false,
      includedArtifacts: [],
      referencedArtifacts: [],
    }
  }
}
