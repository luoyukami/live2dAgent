import type { AvatarDriver } from "./avatar-driver.js"

/**
 * NoopAvatarDriver — a stub implementation that does nothing.
 *
 * Useful for development without a Live2D runtime or for testing.
 */
export class NoopAvatarDriver implements AvatarDriver {
  async load(_modelPath: string): Promise<void> {
    // No-op
  }

  async setExpression(_name: string): Promise<void> {
    // No-op
  }

  async playMotion(_group: string, _index?: number): Promise<void> {
    // No-op
  }

  setLipSync(_value: number): void {
    // No-op
  }

  async dispose(): Promise<void> {
    // No-op
  }
}
