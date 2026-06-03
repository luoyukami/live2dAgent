import type { PetAgentApi } from "../preload/index"

declare global {
  interface Window {
    petAgent: PetAgentApi
  }
}

export {}
