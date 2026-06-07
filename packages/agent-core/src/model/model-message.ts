/**
 * Provider-neutral canonical model message types.
 *
 * These types describe messages and content parts in a way that is
 * independent of any specific model provider. Protocol encoders map
 * these to/from provider-specific payloads.
 *
 * See docs/mimo_ws_runtime_refactor_plan.md §6.1–§6.2.
 */

/* ------------------------------------------------------------------ */
/*  ModelContentPart                                                    */
/* ------------------------------------------------------------------ */

/**
 * A single content part inside a model message.
 *
 * - `text`: plain text
 * - `image`: base64-encoded image (inline or artifact-referenced)
 * - `audio`: base64-encoded audio (inline or artifact-referenced; not
 *            currently supported by the default provider encoder)
 * - `file_ref`: reference to a previously stored artifact without
 *               re-sending the raw bytes
 */
export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string; source: "artifact" | "inline"; artifactId?: string }
  | { type: "audio"; mime: string; data: string; source: "artifact" | "inline"; artifactId?: string }
  | { type: "file_ref"; artifactId: string; mime: string; name?: string }

/* ------------------------------------------------------------------ */
/*  ModelMessage                                                       */
/* ------------------------------------------------------------------ */

/**
 * A single message sent to or received from a model.
 *
 * - `role` follows the standard chat-completion semantics.
 * - `content` is always an array of parts (never a raw string).
 * - `toolCallId` links a tool-role message back to the originating call.
 */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: ModelContentPart[]
  toolCallId?: string
}
