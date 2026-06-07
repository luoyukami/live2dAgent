/**
 * MiMo/OpenAI-Compatible Content Part Encoder.
 *
 * Converts canonical ModelContentPart[] into the provider wire format:
 *
 * | Canonical type | Provider type      | Notes                          |
 * |----------------|--------------------|--------------------------------|
 * | text           | input_text         | Direct mapping                 |
 * | image          | input_image        | data URL with mime + base64    |
 * | audio          | —                  | Throws UnsupportedInputPartError |
 * | file_ref       | —                  | Throws UnsupportedInputPartError |
 *
 * This module MUST NOT generate text placeholders like "[Image included]"
 * or "[Audio included]".
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §8.3
 */

import type { ModelContentPart } from "@live2d-agent/agent-core"
import { UnsupportedInputPartError } from "./mimo-errors.js"

/* ------------------------------------------------------------------ */
/*  Provider Wire Format Content Parts                                 */
/* ------------------------------------------------------------------ */

/**
 * A content part as sent to the MiMo/OpenAI-compatible provider.
 */
export type ProviderContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }

/* ------------------------------------------------------------------ */
/*  Encoder                                                            */
/* ------------------------------------------------------------------ */

/**
 * Encode a canonical message content (array of parts) into provider format.
 *
 * @param content - Array of canonical content parts.
 * @returns Provider-ready content part array.
 * @throws {UnsupportedInputPartError} If an audio or file_ref part is encountered.
 */
export function encodeContent(content: ModelContentPart[]): ProviderContentPart[] {
  const result: ProviderContentPart[] = []

  for (const part of content) {
    switch (part.type) {
      case "text":
        result.push({
          type: "input_text",
          text: part.text,
        })
        break

      case "image": {
        const imageUrl = `data:${part.mime};base64,${part.data}`
        result.push({
          type: "input_image",
          image_url: imageUrl,
        })
        break
      }

      case "audio":
        throw new UnsupportedInputPartError(
          "audio",
          "Audio input parts are not supported by this provider runtime. " +
          "Do not send raw audio to the model; use text-based alternatives.",
        )

      case "file_ref":
        throw new UnsupportedInputPartError(
          "file_ref",
          "File reference parts are not supported by this provider runtime. " +
          "Resolve file references to text or image before sending.",
        )

      default:
        // Exhaustiveness check — if a new type is added to ModelContentPart,
        // this will fail at compile time.
        throw new UnsupportedInputPartError(
          (part as { type: string }).type,
          `Unknown content part type: "${(part as { type: string }).type}"`,
        )
    }
  }

  return result
}
