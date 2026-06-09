import { readFileSync } from "node:fs"
import { basename } from "node:path"

/* ------------------------------------------------------------------ */
/*  Response / input types                                              */
/* ------------------------------------------------------------------ */

export interface TtsHealth {
  status: string
  modelDir?: string
  sampleRate?: number
  cuda?: boolean
}

export interface RegisterVoiceInput {
  voiceId: string
  promptText: string
  promptWavPath: string
  overwrite?: boolean
}

export interface GenerateZeroShotInput {
  text: string
  voiceId: string
  speed?: number
  seed?: number
}

export interface GenerateInstructInput {
  text: string
  instruction: string
  voiceId: string
  speed?: number
  seed?: number
}

/* ------------------------------------------------------------------ */
/*  Client                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 120_000

export class LocalTtsClient {
  constructor(private readonly baseUrl: string) {}

  /* ---- Health ---- */

  async health(): Promise<TtsHealth> {
    const res = await this.get("/health")
    return (await res.json()) as TtsHealth
  }

  /* ---- Voice management ---- */

  async listVoices(): Promise<Array<{ voiceId: string; promptText?: string }>> {
    const res = await this.get("/v1/voices")
    const data = (await res.json()) as { voices: Array<{ voiceId: string; promptText?: string }> }
    return data.voices ?? []
  }

  async registerVoice(input: RegisterVoiceInput): Promise<{ ok: boolean; voiceId: string; error?: string }> {
    const form = new FormData()
    form.append("voice_id", input.voiceId)
    form.append("prompt_text", input.promptText)

    // Read the WAV file from disk and attach as a Blob
    const wavBuffer = readFileSync(input.promptWavPath)
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" })
    form.append("prompt_wav", wavBlob, basename(input.promptWavPath))

    if (input.overwrite) {
      form.append("overwrite", "true")
    }

    const res = await this.post("/v1/voices/register", form)
    return (await res.json()) as { ok: boolean; voiceId: string; error?: string }
  }

  async renameVoice(
    voiceId: string,
    newVoiceId: string,
    overwrite?: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const form = new FormData()
    form.append("new_voice_id", newVoiceId)
    if (overwrite) {
      form.append("overwrite", "true")
    }

    const res = await this.patch(`/v1/voices/${encodeURIComponent(voiceId)}/rename`, form)
    return (await res.json()) as { ok: boolean; error?: string }
  }

  async deleteVoice(voiceId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.delete(`/v1/voices/${encodeURIComponent(voiceId)}`)
    return (await res.json()) as { ok: boolean; error?: string }
  }

  /* ---- TTS generation ---- */

  async generateZeroShot(input: GenerateZeroShotInput, signal?: AbortSignal): Promise<ArrayBuffer> {
    const form = new FormData()
    form.append("voice_id", input.voiceId)
    form.append("text", input.text)
    if (input.speed !== undefined) {
      form.append("speed", String(input.speed))
    }
    if (input.seed !== undefined && input.seed >= 0) {
      form.append("seed", String(input.seed))
    }

    return this.postAudio("/v1/tts/zero-shot", form, signal)
  }

  async generateInstruct(input: GenerateInstructInput, signal?: AbortSignal): Promise<ArrayBuffer> {
    const form = new FormData()
    form.append("voice_id", input.voiceId)
    form.append("text", input.text)
    form.append("instruction", input.instruction)
    if (input.speed !== undefined) {
      form.append("speed", String(input.speed))
    }
    if (input.seed !== undefined && input.seed >= 0) {
      form.append("seed", String(input.seed))
    }

    return this.postAudio("/v1/tts/instruct", form, signal)
  }

  /* ---- Internal helpers ---- */

  private async get(path: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`TTS GET ${path} failed (${res.status}): ${text}`)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  private async post(path: string, body: FormData): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`TTS POST ${path} failed (${res.status}): ${text}`)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  private async patch(path: string, body: FormData): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "PATCH",
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`TTS PATCH ${path} failed (${res.status}): ${text}`)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  private async delete(path: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "DELETE",
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`TTS DELETE ${path} failed (${res.status}): ${text}`)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * POST a request and expect audio/wav back.
   * Throws if the response Content-Type is not audio.
   */
  private async postAudio(path: string, body: FormData, signal?: AbortSignal): Promise<ArrayBuffer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    // Link external signal to internal controller
    if (signal) {
      if (signal.aborted) {
        controller.abort()
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true })
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        body,
        signal: controller.signal,
      })

      const contentType = res.headers.get("content-type") ?? ""

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`TTS POST ${path} failed (${res.status}): ${text}`)
      }

      if (!contentType.includes("audio/wav") && !contentType.includes("audio/")) {
        const text = await res.text().catch(() => "")
        throw new Error(`TTS POST ${path} returned unexpected Content-Type "${contentType}": ${text}`)
      }

      return await res.arrayBuffer()
    } finally {
      clearTimeout(timer)
    }
  }
}
