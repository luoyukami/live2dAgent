/**
 * Runtime mode resolution.
 *
 * Decides whether the configured `openaiBaseUrl` should be served by the
 * WebSocket runtime (MiMo `AssistantRuntime` + `MimoWsRuntime`) or the
 * HTTP-legacy runtime (`OpenAiCompatibleAdapter` + `AgentSession`).
 *
 * Why this exists:
 *   The MiMo WS runtime opens a WebSocket against the configured baseUrl.
 *   For an `https://.../chat/completions` URL the WS upgrade returns 404
 *   ("Unexpected server response: 404") because that endpoint only
 *   accepts HTTP POST. Previously, this caused a silent failure: the user
 *   saw their message echoed but never got a response, and the error
 *   text was only written to the trace JSONL.
 *
 * Resolution rules:
 *   - `runtimeMode === "http-legacy"`              → use HTTP
 *   - `runtimeMode === "ws"` + URL is `ws(s)://...`→ use WS
 *   - `runtimeMode === "ws"` + URL is `http(s)://` → FALL BACK to HTTP
 *     so the chat works out of the box, and surface a clear
 *     `fallbackReason` for the agent service to log.
 *
 * Settings on disk are NOT auto-rewritten: a user that flips their baseUrl
 * back to a real WS endpoint should not have to re-pick the runtime mode.
 */
import type { AgentSettings } from "@live2d-agent/shared"

export type ResolvedRuntimeMode = "ws" | "http-legacy"

export interface RuntimeModeResolution {
  mode: ResolvedRuntimeMode
  /**
   * When the resolver downgrades from "ws" to "http-legacy", this string
   * explains why. `undefined` when no downgrade was needed.
   */
  fallbackReason?: string
}

export function resolveRuntimeMode(
  runtimeMode: AgentSettings["runtimeMode"],
  baseUrl: string,
): RuntimeModeResolution {
  if (runtimeMode === "http-legacy") {
    return { mode: "http-legacy" }
  }

  const trimmed = (baseUrl ?? "").trim().toLowerCase()
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return { mode: "ws" }
  }

  return {
    mode: "http-legacy",
    fallbackReason:
      `Runtime mode "ws" requires a ws:// or wss:// baseUrl; ` +
      `got "${baseUrl}". Falling back to "http-legacy" so the chat still works.`,
  }
}
