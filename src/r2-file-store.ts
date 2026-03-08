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
    const listed = await this.bucket.list({ prefix: PREFIX, limit: 1000 })
    return listed.objects.map((obj) => {
      const meta = (obj.customMetadata ?? {}) as MetaFields
      const createdAt = parseCreatedAt(meta.createdAt, obj.uploaded)
      const filename = meta.filename ?? toId(obj.key)
      const mimeType = meta.mimeType ?? obj.httpMetadata?.contentType ?? "application/octet-stream"
      return {
        id: toId(obj.key),
        filename,
        mimeType,
        sizeBytes: obj.size,
        createdAt,
      }
    })
  }

  async delete(fileId: string): Promise<boolean> {
    await this.bucket.delete(toKey(fileId))
    return true
  }

  async stats(): Promise<unknown> {
    const files = await this.list()
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
    const before = await this.list()
    const deletedExpired = await this.deleteExpired(before)
    const afterExpired = await this.list()
    const deletedEvicted = await this.evictIfNeeded(afterExpired, 0)
    const after = await this.list()
    const totalBytes = after.reduce((sum, file) => sum + file.sizeBytes, 0)
    return {
      backend: "r2",
      policy: this.policy,
      deletedExpired,
      deletedEvicted,
      stats: {
        fileCount: after.length,
        totalBytes,
      },
    }
  }

  private async cleanupInternal(incomingBytes: number): Promise<void> {
    const files = await this.list()
    await this.deleteExpired(files)
    const afterExpired = await this.list()
    await this.evictIfNeeded(afterExpired, incomingBytes)
    const finalFiles = await this.list()
    const finalTotal = finalFiles.reduce((sum, file) => sum + file.sizeBytes, 0)
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

  private async deleteExpired(files: ReadonlyArray<StoredFileMeta>): Promise<number> {
    const expired = files.filter((f) => isExpired(f.createdAt, this.policy.ttlHours))
    if (expired.length === 0) return 0
    await this.bucket.delete(expired.map((f) => toKey(f.id)))
    return expired.length
  }

  private async evictIfNeeded(files: ReadonlyArray<StoredFileMeta>, incomingBytes: number): Promise<number> {
    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
    const projected = totalBytes + incomingBytes
    if (projected <= this.policy.maxTotalBytes) return 0

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
    if (evict.length === 0) return 0
    await this.bucket.delete(evict.map((f) => toKey(f.id)))
    return evict.length
  }
}

