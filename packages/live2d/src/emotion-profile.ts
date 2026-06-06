/**
 * Re-export of the emotion profile types and helpers from `@live2d-agent/shared`.
 *
 * The live2d package historically defined these locally. They were moved to
 * shared so the renderer / settings can reference them without a circular
 * dependency. The re-exports below keep the `@live2d-agent/live2d` API surface
 * backwards compatible.
 */
export type {
  Emotion,
  Live2DEmotionBinding,
  Live2DEmotionProfile,
} from "@live2d-agent/shared"
export {
  DEFAULT_LIVE2D_EMOTION_PROFILE,
  resolveEmotionBinding,
} from "@live2d-agent/shared"
