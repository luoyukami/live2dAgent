import { App } from "./App"

/**
 * UiApp — Chat + settings + debug window (Phase 1 placeholder).
 *
 * Phase 2: Replace this with a component that renders only the interactive
 * UI portions: compact input bar, detail overlay (chat / settings / debug),
 * approval bubbles, and attachment management. The Live2D stage will be
 * displayed in the separate avatar window. State will be synchronised across
 * windows via IPC events emitted from here to the avatar window.
 *
 * The interactive UI is extracted from App.tsx's compact-bar and
 * detail-overlay sections (plus floating approvals).
 */
export function UiApp(): JSX.Element {
  return <App />
}
