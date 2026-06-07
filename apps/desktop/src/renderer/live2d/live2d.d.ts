/* Minimal type declarations for pixi-live2d-display-lipsyncpatch */
declare module "pixi-live2d-display-lipsyncpatch" {
  import { Sprite } from "pixi.js"

  /**
   * Minimal surface of the internal Cubism core model. Only the APIs we
   * actually call from the renderer are declared; see
   * `node_modules/.../pixi-live2d-display-lipsyncpatch/dist/cubism4.es.js`
   * for the full reference.
   */
  interface CubismCoreLike {
    /**
     * Directly set a Cubism parameter to `value` (with optional `weight`).
     * Persists into `coreModel._parameterValues` and is rendered on the next
     * frame's `model.update()`, bypassing the expression / motion queues.
     */
    setParameterValueById(parameterId: string, value: number, weight?: number): void
  }

  export class Live2DModel extends Sprite {
    static from(modelUrl: string): Promise<Live2DModel>
    static fromSync(modelUrl: string): Live2DModel

    readonly internalModel: {
      motionManager: {
        startMotion(group: string, index: number, priority: number): Promise<void>
      }
      /** Underlying Cubism model. Exposed for `setParameterValueById` quirks. */
      coreModel: CubismCoreLike
    }

    motion(group: string, index?: number): Promise<boolean>
    expression(name: string): Promise<boolean>
    focus(x: number, y: number): void
    focusPosition(): { x: number; y: number }

    destroy(): void
  }
}
