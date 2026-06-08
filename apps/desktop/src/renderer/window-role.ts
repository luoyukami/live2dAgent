/**
 * Window role detection for dual-window migration (Phase 1).
 *
 * The renderer reads `?window=` from the URL search params to determine which
 * role this window instance should assume. In Phase 1, all roles render the
 * existing monolithic App; the structure is established here so that Phase 2
 * can swap in lightweight role-specific roots.
 *
 * Phase 2 (dual-window): Main process will open separate BrowserWindows with
 * different query params:
 *   - `?window=avatar` → dedicated Live2D avatar window (transparent overlay,
 *     click-through passthrough, no interactive chrome)
 *   - `?window=ui`     → dedicated chat + settings + debug window (standard
 *     window, fully interactive)
 *   - (none / other)   → combined single-window mode (current behaviour)
 */

export type WindowRole = "avatar" | "ui" | "combined"

/**
 * Read the window role from `location.search`.
 * Falls back to `"combined"` when the param is missing or unrecognised.
 */
export function getWindowRole(): WindowRole {
  if (typeof window === "undefined") return "combined"
  const params = new URLSearchParams(window.location.search)
  const role = params.get("window")
  if (role === "avatar") return "avatar"
  if (role === "ui") return "ui"
  return "combined"
}
