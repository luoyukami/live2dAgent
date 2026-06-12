import React from "react"
import { createRoot } from "react-dom/client"
import { AvatarApp } from "./AvatarApp"
import { UiApp } from "./UiApp"
import { getWindowRole, type WindowRole } from "./window-role"
import "./styles.css"

/**
 * Root component selected by window role.
 * Only dual-window mode: avatar → AvatarApp, ui → UiApp.
 */
const ROLE: WindowRole = getWindowRole()

function Root(): JSX.Element {
  switch (ROLE) {
    case "avatar":
      return <AvatarApp />
    case "ui":
      return <UiApp />
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
