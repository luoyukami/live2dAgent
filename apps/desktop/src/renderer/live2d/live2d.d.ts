/* Minimal type declarations for pixi-live2d-display-lipsyncpatch */
declare module "pixi-live2d-display-lipsyncpatch" {
  import { Sprite } from "pixi.js"

  export class Live2DModel extends Sprite {
    static from(modelUrl: string): Promise<Live2DModel>
    static fromSync(modelUrl: string): Live2DModel

    readonly internalModel: {
      motionManager: {
        startMotion(group: string, index: number, priority: number): Promise<void>
      }
    }

    motion(group: string, index?: number): Promise<boolean>
    expression(name: string): Promise<boolean>
    focus(x: number, y: number): void
    focusPosition(): { x: number; y: number }

    destroy(): void
  }
}
