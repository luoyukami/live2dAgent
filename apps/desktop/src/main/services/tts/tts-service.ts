import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_LOCAL_TTS_SETTINGS,
  type IpcTtsGenerateRequest,
  type IpcTtsGenerateResponse,
  type IpcTtsHealthCheckResponse,
  type IpcTtsListVoicesResponse,
  type IpcTtsRegisterVoiceRequest,
  type LocalTtsSettings,
  type TtsSettingsPatch,
} from "@live2d-agent/shared"
import { LocalTtsClient } from "./local-tts-client.js"
import type { SettingsService } from "../settings-service.js"

/* ------------------------------------------------------------------ */
/*  TtsService                                                         */
/* ------------------------------------------------------------------ */

export class TtsService {
  private client: LocalTtsClient
  private currentApiBaseUrl: string
  /** Track the active abort controller so we can cancel playback. */
  private activeController: AbortController | null = null
  /** Queue to ensure only 1 TTS generation runs at a time. */
  private generateQueue: Array<{
    req: IpcTtsGenerateRequest
    resolve: (value: IpcTtsGenerateResponse) => void
    reject: (reason: unknown) => void
  }> = []
  private isGenerating = false

  constructor(
    private readonly settings: SettingsService,
  ) {
    const ttsSettings = this.settings.get().tts
    this.currentApiBaseUrl = ttsSettings.apiBaseUrl
    this.client = new LocalTtsClient(this.currentApiBaseUrl)
  }

  /* ---- Settings access ---- */

  getSettings(): LocalTtsSettings {
    return { ...this.settings.get().tts }
  }

  updateSettings(patch: Partial<LocalTtsSettings>): void {
    this.settings.updatePublicPatch({ tts: patch })
    this.reconcileClient()
  }

  getAudioOutputDir(): string {
    const dir = this.settings.get().tts.audioOutputDir
    if (dir && dir.trim().length > 0) return dir
    // Default: <userData>/tts-audio
    const userDataDir = join(this.settings.get().workspaceDir, "..")
    return join(userDataDir, "tts-audio")
  }

  /* ---- Health ---- */

  async healthCheck(): Promise<IpcTtsHealthCheckResponse> {
    try {
      this.reconcileClient()
      const health = await this.client.health()
      return {
        ok: true,
        status: health.status,
        modelDir: health.modelDir,
        sampleRate: health.sampleRate,
        cuda: health.cuda,
      }
    } catch (err) {
      return {
        ok: false,
        error: friendlyError(err),
      }
    }
  }

  /* ---- Voice management ---- */

  async listVoices(): Promise<IpcTtsListVoicesResponse> {
    try {
      this.reconcileClient()
      const voices = await this.client.listVoices()
      return { voices }
    } catch (err) {
      throw new Error(`Failed to list voices: ${friendlyError(err)}`)
    }
  }

  async registerVoice(req: IpcTtsRegisterVoiceRequest): Promise<{ ok: boolean; error?: string }> {
    try {
      this.reconcileClient()
      const result = await this.client.registerVoice({
        voiceId: req.voiceId,
        promptText: req.promptText,
        promptWavPath: req.promptWavPath,
        overwrite: req.overwrite,
      })
      return result
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  }

  async renameVoice(
    voiceId: string,
    newVoiceId: string,
    overwrite?: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      this.reconcileClient()
      return await this.client.renameVoice(voiceId, newVoiceId, overwrite)
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  }

  async deleteVoice(voiceId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      this.reconcileClient()
      return await this.client.deleteVoice(voiceId)
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  }

  /* ---- TTS generation ---- */

  async generate(req: IpcTtsGenerateRequest): Promise<IpcTtsGenerateResponse> {
    return new Promise((resolve, reject) => {
      this.generateQueue.push({ req, resolve, reject })
      this.processGenerateQueue()
    })
  }

  private async processGenerateQueue(): Promise<void> {
    if (this.isGenerating || this.generateQueue.length === 0) return
    this.isGenerating = true

    const { req, resolve, reject } = this.generateQueue.shift()!

    try {
      this.activeController = new AbortController()
      const result = await this.doGenerate(req)
      resolve(result)
    } catch (err) {
      reject(err)
    } finally {
      this.isGenerating = false
      this.activeController = null
      // Process next item in queue
      this.processGenerateQueue()
    }
  }

  private async doGenerate(req: IpcTtsGenerateRequest): Promise<IpcTtsGenerateResponse> {
    try {
      this.reconcileClient()
      const ttsSettings = this.settings.get().tts

      // Determine the endpoint and instruction
      const useInstruct = req.mode === "emotion_enhanced" && req.instruction

      const signal = this.activeController?.signal

      let audioBuffer: ArrayBuffer
      if (useInstruct) {
        audioBuffer = await this.client.generateInstruct(
          {
            text: req.text,
            voiceId: req.voiceId,
            instruction: req.instruction!,
            speed: req.speed ?? ttsSettings.speed,
            seed: req.seed ?? ttsSettings.seed,
          },
          signal,
        )
      } else {
        audioBuffer = await this.client.generateZeroShot(
          {
            text: req.text,
            voiceId: req.voiceId,
            speed: req.speed ?? ttsSettings.speed,
            seed: req.seed ?? ttsSettings.seed,
          },
          signal,
        )
      }

      // Save the audio buffer to disk
      const audioPath = this.saveAudioFile(
        audioBuffer,
        req.messageId,
        req.voiceId,
        useInstruct ? "instruct" : "zero-shot",
      )

      return { ok: true, audioPath }
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  }

  /* ---- Audio playback helpers ---- */

  async playAudio(audioPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(audioPath)) {
      return { ok: false, error: `Audio file not found: ${audioPath}` }
    }
    // Playback is handled by the renderer via HTML5 Audio.
    // Main process only validates the file exists.
    return { ok: true }
  }

  async stopAudio(): Promise<void> {
    // Cancel any in-flight generation request
    if (this.activeController) {
      this.activeController.abort()
      this.activeController = null
    }
    // Reject all queued items
    for (const item of this.generateQueue) {
      item.resolve({ ok: false, error: "Cancelled" })
    }
    this.generateQueue = []
    this.isGenerating = false
  }

  /* ---- Private helpers ---- */

  /**
   * Ensure the LocalTtsClient is up-to-date with the latest settings.
   */
  private reconcileClient(): void {
    const ttsSettings = this.settings.get().tts
    if (ttsSettings.apiBaseUrl !== this.currentApiBaseUrl) {
      this.currentApiBaseUrl = ttsSettings.apiBaseUrl
      this.client = new LocalTtsClient(this.currentApiBaseUrl)
    }

    // Ensure the output directory exists
    const outputDir = this.getAudioOutputDir()
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }
  }

  /**
   * Save an ArrayBuffer as a WAV file and return the file path.
   *
   * File naming: `tts_{yyyyMMdd_HHmmss}_{messageId}_{voiceId}_{mode}.wav`
   */
  private saveAudioFile(
    buffer: ArrayBuffer,
    messageId: string,
    voiceId: string,
    mode: string,
  ): string {
    const outputDir = this.getAudioOutputDir()
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const now = new Date()
    const timestamp = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "_",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join("")

    const safeMessageId = sanitizeFilename(messageId)
    const safeVoiceId = sanitizeFilename(voiceId)
    const safeMode = sanitizeFilename(mode)

    const filename = `tts_${timestamp}_${safeMessageId}_${safeVoiceId}_${safeMode}.wav`
    const filePath = join(outputDir, filename)

    writeFileSync(filePath, Buffer.from(buffer))
    return filePath
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Strip characters that are illegal in file names across platforms.
 */
function sanitizeFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
}

function friendlyError(err: unknown): string {
  if (err instanceof Error) {
    // Timeout / abort
    if (err.name === "AbortError") {
      return "TTS request timed out or was cancelled"
    }
    return err.message
  }
  return String(err)
}
