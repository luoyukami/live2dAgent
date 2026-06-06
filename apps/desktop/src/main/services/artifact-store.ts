import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { ArtifactKind, ArtifactRef } from "@live2d-agent/shared"

/**
 * Manages storing and reading tool artifacts (screenshots, file content, etc.)
 * on disk under `userData/artifacts/`.
 *
 * Artifacts are organised by kind into subdirectories:
 *   - userData/artifacts/screenshots/
 *   - userData/artifacts/tool-output/
 *   - userData/artifacts/file-content/
 */
export class ArtifactStore {
  private readonly baseDir: string

  constructor(userDataDir: string) {
    this.baseDir = join(userDataDir, "artifacts")
    for (const dir of ["screenshots", "tool-output", "file-content", "audio"]) {
      mkdirSync(join(this.baseDir, dir), { recursive: true })
    }
  }

  /**
   * Save a Buffer artifact to disk and return a reference.
   */
  saveArtifact(params: {
    kind: ArtifactKind
    mimeType: string
    data: Buffer
    ext?: string
  }): ArtifactRef {
    const { kind, mimeType, data, ext } = params
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const extension = ext ?? ".bin"
    const dir = join(this.baseDir, this.kindToDir(kind))
    const filename = `${id}${extension.startsWith(".") ? extension : `.${extension}`}`
    const filePath = join(dir, filename)
    writeFileSync(filePath, data)
    return {
      id,
      kind,
      path: filePath,
      mimeType,
      size: data.length,
      createdAt: Date.now(),
    }
  }

  /**
   * Read an artifact's contents from disk by its reference.
   */
  readArtifact(ref: ArtifactRef): Buffer {
    const root = realpathSync(this.baseDir)
    const target = realpathSync(ref.path)
    if (!isInside(root, target)) {
      throw new Error("Artifact path is outside artifact store")
    }
    return readFileSync(target)
  }

  getBaseDir(): string {
    return this.baseDir
  }

  private kindToDir(kind: ArtifactKind): string {
    switch (kind) {
      case "screenshot":
        return "screenshots"
      case "tool-output":
        return "tool-output"
      case "file-content":
        return "file-content"
      case "audio":
        return "audio"
    }
  }
}

function isInside(parent: string, target: string): boolean {
  const rel = relative(parent, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}
