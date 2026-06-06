/**
 * Pure WAV encoder — encodes PCM Float32 samples into a standard RIFF WAVE Blob.
 *
 * Format: PCM 16-bit little-endian, mono or stereo, 44-byte RIFF header.
 *
 * Note on ScriptProcessor vs AudioWorklet:
 * We use ScriptProcessorNode (deprecated) in useAudioRecorder because it is
 * universally supported across all Chromium versions shipped with Electron.
 * AudioWorklet is the modern replacement but requires loading a separate JS
 * file and may hit CSP restrictions in sandboxed Electron renderers. The
 * trade-off is a slight GC pressure from Float32Array copies on the audio
 * thread, which is acceptable for a v0 voice input feature.
 */

export interface PcmInput {
  /** Mono or interleaved stereo PCM samples, normalized to [-1, 1]. */
  samples: Float32Array
  sampleRate: number
  /** 1 = mono, 2 = stereo. Default 1. */
  numChannels?: number
}

/**
 * Encode a single Float32Array of PCM samples into a WAV Blob.
 *
 * Samples are clipped to [-1, 1] and quantized to 16-bit signed integers
 * in little-endian byte order, wrapped in a standard 44-byte RIFF header.
 */
export function encodeWav(input: PcmInput): Blob {
  const { samples, sampleRate, numChannels = 1 } = input
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const numSamples = samples.length
  const dataSize = numSamples * (bitsPerSample / 8)

  // 44-byte RIFF header + data
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true) // file size - 8
  writeString(view, 8, "WAVE")

  // fmt subchunk
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true) // subchunk1 size (PCM)
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  // data subchunk
  writeString(view, 36, "data")
  view.setUint32(40, dataSize, true)

  // Write PCM samples — clip and quantize to int16 LE
  const pcm = new Int16Array(buffer, 44)
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF)
  }

  return new Blob([buffer], { type: "audio/wav" })
}

/**
 * Stream encoder: accumulate Float32Array chunks and produce a WAV Blob
 * when the recording finishes. Avoids holding the entire recording in
 * a single large Float32Array while recording is in progress.
 *
 * ```ts
 * const enc = new WavStreamEncoder(48000)
 * // on each audio frame:
 * enc.push(inputChannelData)
 * // when stopped:
 * const blob = enc.finalize()
 * ```
 */
export class WavStreamEncoder {
  private _sampleRate: number
  private _numChannels: number
  private _chunks: Float32Array[] = []
  private _totalSamples = 0

  constructor(sampleRate: number, numChannels = 1) {
    this._sampleRate = sampleRate
    this._numChannels = numChannels
  }

  /** Append a chunk of PCM samples (mono or interleaved stereo). */
  push(chunk: Float32Array): void {
    // We make a copy because ScriptProcessor reuses the same buffer
    this._chunks.push(new Float32Array(chunk))
    this._totalSamples += chunk.length
  }

  /** Total number of samples pushed so far (across all channels). */
  get totalSamples(): number {
    return this._totalSamples
  }

  /** Estimated duration in milliseconds. */
  get durationMs(): number {
    if (this._sampleRate === 0) return 0
    return (this._totalSamples / (this._sampleRate * this._numChannels)) * 1000
  }

  /**
   * Merge all pushed chunks into a single Float32Array and encode as WAV.
   * After calling finalize(), the internal buffers are released.
   */
  finalize(): Blob {
    if (this._totalSamples === 0) {
      return new Blob([], { type: "audio/wav" })
    }
    const merged = new Float32Array(this._totalSamples)
    let offset = 0
    for (const chunk of this._chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this._chunks = []

    return encodeWav({
      samples: merged,
      sampleRate: this._sampleRate,
      numChannels: this._numChannels,
    })
  }
}

/* ---- internal helpers ---- */

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
