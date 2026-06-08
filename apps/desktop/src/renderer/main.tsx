import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { AvatarApp } from "./AvatarApp"
import { UiApp } from "./UiApp"
import { getWindowRole, type WindowRole } from "./window-role"
import "./styles.css"

/**
 * Root component selected by window role.
 *
 * Phase 1: All roles render the existing monolithic App.
 * Phase 2: avatar → AvatarApp, ui → UiApp, combined → App.
 */
const ROLE: WindowRole = getWindowRole()

function Root(): JSX.Element {
  switch (ROLE) {
    case "avatar":
      return <AvatarApp />
    case "ui":
      return <UiApp />
    default:
      return <App />
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
