/**
 * Window role detection for dual-window mode.
 *
 * The renderer reads `?window=` from the URL search params to determine which
 * role this window instance should assume:
 *   - `?window=avatar` → dedicated Live2D avatar window (transparent overlay,
 *     click-through passthrough, no interactive chrome)
 *   - `?window=ui`     → dedicated chat + settings + debug window (standard
 *     window, fully interactive)
 *   - (none / other)   → defaults to "ui"
 */

export type WindowRole = "avatar" | "ui"

/**
 * Read the window role from `location.search`.
 * Falls back to `"ui"` when the param is missing or unrecognised.
 */
export function getWindowRole(): WindowRole {
  if (typeof window === "undefined") return "ui"
  const params = new URLSearchParams(window.location.search)
  const role = params.get("window")
  if (role === "avatar") return "avatar"
  return "ui"
}
