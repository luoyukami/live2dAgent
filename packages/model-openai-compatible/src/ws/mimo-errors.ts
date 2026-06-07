/**
 * MiMo-specific error types for the WS runtime layer.
 *
 * These errors are thrown or returned by the encoder/decoder/protocol
 * when the provider payload cannot be parsed or contains unsupported parts.
 *
 * Reference: docs/mimo_ws_runtime_refactor_plan.md §8.3
 */

/**
 * Error thrown when a content part type is not supported by the current
 * MiMo/OpenAI-compatible protocol (e.g. audio input).
 */
export class UnsupportedInputPartError extends Error {
  readonly partType: string

  constructor(partType: string, message?: string) {
    super(message ?? `Unsupported input part type: "${partType}"`)
    this.name = "UnsupportedInputPartError"
    this.partType = partType
  }
}

/**
 * Error thrown when the provider returns a frame that cannot be decoded
 * as a valid protocol event.
 */
export class ProtocolDecodeError extends Error {
  readonly rawPayload: unknown

  constructor(message: string, rawPayload?: unknown) {
    super(message)
    this.name = "ProtocolDecodeError"
    this.rawPayload = rawPayload
  }
}

/**
 * Error thrown when the connection is not in the expected state for an
 * operation (e.g. sendJson before connect completes).
 */
export class ConnectionStateError extends Error {
  readonly expectedState: string
  readonly actualState: string

  constructor(expectedState: string, actualState: string) {
    super(`Connection state error: expected "${expectedState}", got "${actualState}"`)
    this.name = "ConnectionStateError"
    this.expectedState = expectedState
    this.actualState = actualState
  }
}
