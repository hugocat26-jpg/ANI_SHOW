import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface PrivacyLogFile {
  path: string
  sizeBytes: number
}

const LOG_EXTENSIONS = new Set(['.log', '.txt', '.jsonl', '.ndjson'])
const MAX_LOG_FILES = 500

export class PrivacyFileManager {
  private readonly logRoot: string

  constructor(logRoot = path.join(process.cwd(), 'userData', 'logs')) {
    this.logRoot = path.resolve(logRoot)
  }

  async listLogFiles(): Promise<PrivacyLogFile[]> {
    const files: PrivacyLogFile[] = []
    await this.walk(this.logRoot, files)
    return files
  }

  async clearLogFiles(): Promise<{ files: number; bytes: number }> {
    const files = await this.listLogFiles()
    let bytes = 0
    let cleared = 0
    for (const file of files) {
      if (!this.isWithinLogRoot(file.path)) continue
      await rm(file.path, { force: true })
      bytes += file.sizeBytes
      cleared += 1
    }
    return { files: cleared, bytes }
  }

  private async walk(dir: string, files: PrivacyLogFile[]): Promise<void> {
    if (files.length >= MAX_LOG_FILES || !this.isWithinLogRoot(dir, true)) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_LOG_FILES) return
      const fullPath = path.resolve(dir, entry.name)
      if (!this.isWithinLogRoot(fullPath)) continue
      if (entry.isDirectory()) {
        await this.walk(fullPath, files)
      } else if (entry.isFile() && LOG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(fullPath)
        files.push({ path: fullPath, sizeBytes: info.size })
      }
    }
  }

  private isWithinLogRoot(candidate: string, allowRoot = false): boolean {
    const resolved = path.resolve(candidate)
    if (allowRoot && resolved === this.logRoot) return true
    return resolved.startsWith(`${this.logRoot}${path.sep}`)
  }
}
