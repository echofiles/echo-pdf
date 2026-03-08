import { fromBase64, toBase64 } from "./file-utils"
import type { StoragePolicy } from "./pdf-types"
import type { StoredFileMeta, StoredFileRecord } from "./types"

interface StoredValue {
  readonly id: string
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly createdAt: string
  readonly bytesBase64: string
}

interface StoreStats {
  readonly fileCount: number
  readonly totalBytes: number
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body = await request.json()
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

const defaultPolicy = (): StoragePolicy => ({
  maxFileBytes: 1_200_000,
  maxTotalBytes: 52_428_800,
  ttlHours: 24,
  cleanupBatchSize: 50,
})

const parsePolicy = (input: unknown): StoragePolicy => {
  const raw = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
  const fallback = defaultPolicy()

  const maxFileBytes = Number(raw.maxFileBytes ?? fallback.maxFileBytes)
  const maxTotalBytes = Number(raw.maxTotalBytes ?? fallback.maxTotalBytes)
  const ttlHours = Number(raw.ttlHours ?? fallback.ttlHours)
  const cleanupBatchSize = Number(raw.cleanupBatchSize ?? fallback.cleanupBatchSize)

  return {
    maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? Math.floor(maxFileBytes) : fallback.maxFileBytes,
    maxTotalBytes: Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? Math.floor(maxTotalBytes) : fallback.maxTotalBytes,
    ttlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : fallback.ttlHours,
    cleanupBatchSize:
      Number.isFinite(cleanupBatchSize) && cleanupBatchSize > 0 ? Math.floor(cleanupBatchSize) : fallback.cleanupBatchSize,
  }
}

const toMeta = (value: StoredValue): StoredFileMeta => ({
  id: value.id,
  filename: value.filename,
  mimeType: value.mimeType,
  sizeBytes: value.sizeBytes,
  createdAt: value.createdAt,
})

const listStoredValues = async (state: DurableObjectState): Promise<StoredValue[]> => {
  const listed = await state.storage.list<StoredValue>({ prefix: "file:" })
  return [...listed.values()]
}

const computeStats = (files: ReadonlyArray<StoredValue>): StoreStats => ({
  fileCount: files.length,
  totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
})

const isExpired = (createdAt: string, ttlHours: number): boolean => {
  const createdMs = Date.parse(createdAt)
  if (!Number.isFinite(createdMs)) return false
  return Date.now() - createdMs > ttlHours * 60 * 60 * 1000
}

const deleteFiles = async (state: DurableObjectState, files: ReadonlyArray<StoredValue>): Promise<number> => {
  let deleted = 0
  for (const file of files) {
    const ok = await state.storage.delete(`file:${file.id}`)
    if (ok) deleted += 1
  }
  return deleted
}

export class FileStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "POST" && url.pathname === "/put") {
      const body = await readJson(request)
      const policy = parsePolicy(body.policy)
      const filename = typeof body.filename === "string" ? body.filename : `file-${Date.now()}`
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream"
      const bytesBase64 = typeof body.bytesBase64 === "string" ? body.bytesBase64 : ""

      const bytes = fromBase64(bytesBase64)
      if (bytes.byteLength > policy.maxFileBytes) {
        return json(
          {
            error: `file too large: ${bytes.byteLength} bytes exceeds maxFileBytes ${policy.maxFileBytes}`,
            code: "FILE_TOO_LARGE",
            policy,
          },
          413
        )
      }

      let files = await listStoredValues(this.state)
      const expired = files.filter((file) => isExpired(file.createdAt, policy.ttlHours))
      if (expired.length > 0) {
        await deleteFiles(this.state, expired)
        files = await listStoredValues(this.state)
      }

      let stats = computeStats(files)
      const projected = stats.totalBytes + bytes.byteLength
      if (projected > policy.maxTotalBytes) {
        const needFree = projected - policy.maxTotalBytes
        const candidates = [...files]
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .slice(0, policy.cleanupBatchSize)

        let freed = 0
        const evictList: StoredValue[] = []
        for (const file of candidates) {
          evictList.push(file)
          freed += file.sizeBytes
          if (freed >= needFree) break
        }
        if (evictList.length > 0) {
          await deleteFiles(this.state, evictList)
          files = await listStoredValues(this.state)
          stats = computeStats(files)
        }
      }

      if (stats.totalBytes + bytes.byteLength > policy.maxTotalBytes) {
        return json(
          {
            error: `storage quota exceeded: total ${stats.totalBytes} + incoming ${bytes.byteLength} > maxTotalBytes ${policy.maxTotalBytes}`,
            code: "STORAGE_QUOTA_EXCEEDED",
            policy,
            stats,
          },
          507
        )
      }

      const id = crypto.randomUUID()
      const value: StoredValue = {
        id,
        filename,
        mimeType,
        sizeBytes: bytes.byteLength,
        createdAt: new Date().toISOString(),
        bytesBase64,
      }
      await this.state.storage.put(`file:${id}`, value)
      return json({ file: toMeta(value), policy })
    }

    if (request.method === "GET" && url.pathname === "/get") {
      const fileId = url.searchParams.get("fileId")
      if (!fileId) return json({ error: "Missing fileId" }, 400)
      const value = await this.state.storage.get<StoredValue>(`file:${fileId}`)
      if (!value) return json({ file: null })
      return json({ file: value })
    }

    if (request.method === "GET" && url.pathname === "/list") {
      const listed = await this.state.storage.list<StoredValue>({ prefix: "file:" })
      const files = [...listed.values()].map(toMeta)
      return json({ files })
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      const body = await readJson(request)
      const fileId = typeof body.fileId === "string" ? body.fileId : ""
      if (!fileId) return json({ error: "Missing fileId" }, 400)
      const key = `file:${fileId}`
      const existing = await this.state.storage.get(key)
      if (!existing) return json({ deleted: false })
      await this.state.storage.delete(key)
      return json({ deleted: true })
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      let policyInput: unknown
      const encoded = url.searchParams.get("policy")
      if (encoded) {
        try {
          policyInput = JSON.parse(encoded)
        } catch {
          policyInput = undefined
        }
      }
      const policy = parsePolicy(policyInput)
      const files = await listStoredValues(this.state)
      const stats = computeStats(files)
      return json({ policy, stats })
    }

    if (request.method === "POST" && url.pathname === "/cleanup") {
      const body = await readJson(request)
      const policy = parsePolicy(body.policy)
      const files = await listStoredValues(this.state)
      const expired = files.filter((file) => isExpired(file.createdAt, policy.ttlHours))
      const deletedExpired = await deleteFiles(this.state, expired)

      const afterExpired = await listStoredValues(this.state)
      let stats = computeStats(afterExpired)
      let deletedEvicted = 0
      if (stats.totalBytes > policy.maxTotalBytes) {
        const sorted = [...afterExpired].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        const evictList: StoredValue[] = []
        for (const file of sorted) {
          evictList.push(file)
          const projected = stats.totalBytes - evictList.reduce((sum, item) => sum + item.sizeBytes, 0)
          if (projected <= policy.maxTotalBytes) break
          if (evictList.length >= policy.cleanupBatchSize) break
        }
        deletedEvicted = await deleteFiles(this.state, evictList)
        stats = computeStats(await listStoredValues(this.state))
      }

      return json({
        policy,
        deletedExpired,
        deletedEvicted,
        stats,
      })
    }

    return json({ error: "Not found" }, 404)
  }
}

export class DurableObjectFileStore {
  constructor(
    private readonly namespace: DurableObjectNamespace,
    private readonly policy: StoragePolicy
  ) {}

  private stub(): DurableObjectStub {
    return this.namespace.get(this.namespace.idFromName("echo-pdf-file-store"))
  }

  async put(input: {
    readonly filename: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<StoredFileMeta> {
    const response = await this.stub().fetch("https://do/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: input.filename,
        mimeType: input.mimeType,
        bytesBase64: toBase64(input.bytes),
        policy: this.policy,
      }),
    })
    const payload = (await response.json()) as { file?: StoredFileMeta; error?: string }
    if (!response.ok || !payload.file) {
      const details = payload as { error?: string; code?: string; policy?: unknown; stats?: unknown }
      const error = new Error(payload.error ?? "DO put failed") as Error & {
        status?: number
        code?: string
        details?: unknown
      }
      error.status = response.status
      error.code = typeof details.code === "string" ? details.code : undefined
      error.details = { policy: details.policy, stats: details.stats }
      throw error
    }
    return payload.file
  }

  async get(fileId: string): Promise<StoredFileRecord | null> {
    const response = await this.stub().fetch(`https://do/get?fileId=${encodeURIComponent(fileId)}`)
    const payload = (await response.json()) as { file?: StoredValue | null }
    if (!response.ok) throw new Error("DO get failed")
    if (!payload.file) return null
    return {
      id: payload.file.id,
      filename: payload.file.filename,
      mimeType: payload.file.mimeType,
      sizeBytes: payload.file.sizeBytes,
      createdAt: payload.file.createdAt,
      bytes: fromBase64(payload.file.bytesBase64),
    }
  }

  async list(): Promise<ReadonlyArray<StoredFileMeta>> {
    const response = await this.stub().fetch("https://do/list")
    const payload = (await response.json()) as { files?: StoredFileMeta[] }
    if (!response.ok) throw new Error("DO list failed")
    return payload.files ?? []
  }

  async delete(fileId: string): Promise<boolean> {
    const response = await this.stub().fetch("https://do/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId }),
    })
    const payload = (await response.json()) as { deleted?: boolean }
    if (!response.ok) throw new Error("DO delete failed")
    return payload.deleted === true
  }

  async stats(): Promise<{ policy: StoragePolicy; stats: StoreStats }> {
    const policyEncoded = encodeURIComponent(JSON.stringify(this.policy))
    const response = await this.stub().fetch(`https://do/stats?policy=${policyEncoded}`)
    const payload = (await response.json()) as { policy: StoragePolicy; stats: StoreStats }
    if (!response.ok) throw new Error("DO stats failed")
    return payload
  }

  async cleanup(): Promise<{ policy: StoragePolicy; deletedExpired: number; deletedEvicted: number; stats: StoreStats }> {
    const response = await this.stub().fetch("https://do/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: this.policy }),
    })
    const payload = (await response.json()) as {
      policy: StoragePolicy
      deletedExpired: number
      deletedEvicted: number
      stats: StoreStats
    }
    if (!response.ok) throw new Error("DO cleanup failed")
    return payload
  }
}
