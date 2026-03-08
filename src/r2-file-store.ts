import type { StoragePolicy } from "./pdf-types"
import type { FileStore, StoredFileMeta, StoredFileRecord } from "./types"

const PREFIX = "file/"

type MetaFields = {
  filename?: string
  mimeType?: string
  createdAt?: string
}

const toId = (key: string): string => key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key
const toKey = (id: string): string => `${PREFIX}${id}`

const parseCreatedAt = (value: string | undefined, fallback: Date): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  return fallback.toISOString()
}

const isExpired = (createdAtIso: string, ttlHours: number): boolean => {
  const ms = Date.parse(createdAtIso)
  if (!Number.isFinite(ms)) return false
  return Date.now() - ms > ttlHours * 60 * 60 * 1000
}

export class R2FileStore implements FileStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly policy: StoragePolicy
  ) {}

  async put(input: { readonly filename: string; readonly mimeType: string; readonly bytes: Uint8Array }): Promise<StoredFileMeta> {
    const sizeBytes = input.bytes.byteLength
    if (sizeBytes > this.policy.maxFileBytes) {
      const err = new Error(`file too large: ${sizeBytes} bytes exceeds maxFileBytes ${this.policy.maxFileBytes}`)
      ;(err as { status?: number; code?: string; details?: unknown }).status = 413
      ;(err as { status?: number; code?: string; details?: unknown }).code = "FILE_TOO_LARGE"
      ;(err as { status?: number; code?: string; details?: unknown }).details = { policy: this.policy, sizeBytes }
      throw err
    }

    await this.cleanupInternal(sizeBytes)

    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    await this.bucket.put(toKey(id), input.bytes, {
      httpMetadata: {
        contentType: input.mimeType,
      },
      customMetadata: {
        filename: input.filename,
        mimeType: input.mimeType,
        createdAt,
      },
    })

    return { id, filename: input.filename, mimeType: input.mimeType, sizeBytes, createdAt }
  }

  async get(fileId: string): Promise<StoredFileRecord | null> {
    const obj = await this.bucket.get(toKey(fileId))
    if (!obj) return null
    const meta = (obj.customMetadata ?? {}) as MetaFields
    const createdAt = parseCreatedAt(meta.createdAt, obj.uploaded)
    const filename = meta.filename ?? fileId
    const mimeType = meta.mimeType ?? obj.httpMetadata?.contentType ?? "application/octet-stream"
    const bytes = new Uint8Array(await obj.arrayBuffer())
    return {
      id: fileId,
      filename,
      mimeType,
      sizeBytes: bytes.byteLength,
      createdAt,
      bytes,
    }
  }

  async list(): Promise<ReadonlyArray<StoredFileMeta>> {
    return await this.listAllFiles()
  }

  async delete(fileId: string): Promise<boolean> {
    await this.bucket.delete(toKey(fileId))
    return true
  }

  async stats(): Promise<unknown> {
    const files = await this.listAllFiles()
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
    return {
      backend: "r2",
      policy: this.policy,
      stats: {
        fileCount: files.length,
        totalBytes,
      },
    }
  }

  async cleanup(): Promise<unknown> {
    const files = await this.listAllFiles()
    const expired = files.filter((f) => isExpired(f.createdAt, this.policy.ttlHours))
    const active = files.filter((f) => !isExpired(f.createdAt, this.policy.ttlHours))
    if (expired.length > 0) {
      await this.bucket.delete(expired.map((f) => toKey(f.id)))
    }
    const evict = this.pickEvictions(active, 0)
    if (evict.length > 0) {
      await this.bucket.delete(evict.map((f) => toKey(f.id)))
    }
    const evictIds = new Set(evict.map((f) => f.id))
    const after = active.filter((f) => !evictIds.has(f.id))
    const totalBytes = after.reduce((sum, file) => sum + file.sizeBytes, 0)
    return {
      backend: "r2",
      policy: this.policy,
      deletedExpired: expired.length,
      deletedEvicted: evict.length,
      stats: {
        fileCount: after.length,
        totalBytes,
      },
    }
  }

  private async cleanupInternal(incomingBytes: number): Promise<void> {
    const files = await this.listAllFiles()
    const expired = files.filter((f) => isExpired(f.createdAt, this.policy.ttlHours))
    const active = files.filter((f) => !isExpired(f.createdAt, this.policy.ttlHours))
    if (expired.length > 0) {
      await this.bucket.delete(expired.map((f) => toKey(f.id)))
    }
    const evict = this.pickEvictions(active, incomingBytes)
    if (evict.length > 0) {
      await this.bucket.delete(evict.map((f) => toKey(f.id)))
    }
    const evictIds = new Set(evict.map((f) => f.id))
    const remaining = active.filter((f) => !evictIds.has(f.id))
    const finalTotal = remaining.reduce((sum, file) => sum + file.sizeBytes, 0)
    if (finalTotal + incomingBytes > this.policy.maxTotalBytes) {
      const err = new Error(
        `storage quota exceeded: total ${finalTotal} + incoming ${incomingBytes} > maxTotalBytes ${this.policy.maxTotalBytes}`
      )
      ;(err as { status?: number; code?: string; details?: unknown }).status = 507
      ;(err as { status?: number; code?: string; details?: unknown }).code = "STORAGE_QUOTA_EXCEEDED"
      ;(err as { status?: number; code?: string; details?: unknown }).details = { policy: this.policy, totalBytes: finalTotal, incomingBytes }
      throw err
    }
  }

  private pickEvictions(files: ReadonlyArray<StoredFileMeta>, incomingBytes: number): StoredFileMeta[] {
    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
    const projected = totalBytes + incomingBytes
    if (projected <= this.policy.maxTotalBytes) return []

    const needFree = projected - this.policy.maxTotalBytes
    const candidates = [...files].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    const evict: StoredFileMeta[] = []
    let freed = 0
    for (const file of candidates) {
      evict.push(file)
      freed += file.sizeBytes
      if (freed >= needFree) break
      if (evict.length >= this.policy.cleanupBatchSize) break
    }
    return evict
  }

  private async listAllFiles(): Promise<StoredFileMeta[]> {
    const files: StoredFileMeta[] = []
    let cursor: string | undefined
    while (true) {
      const listed = await this.bucket.list({ prefix: PREFIX, limit: 1000, cursor })
      for (const obj of listed.objects) {
        const meta = (obj.customMetadata ?? {}) as MetaFields
        const createdAt = parseCreatedAt(meta.createdAt, obj.uploaded)
        const filename = meta.filename ?? toId(obj.key)
        const mimeType = meta.mimeType ?? obj.httpMetadata?.contentType ?? "application/octet-stream"
        files.push({
          id: toId(obj.key),
          filename,
          mimeType,
          sizeBytes: obj.size,
          createdAt,
        })
      }
      if (listed.truncated !== true || !listed.cursor) break
      cursor = listed.cursor
    }
    return files
  }
}
