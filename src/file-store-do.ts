import { fromBase64, toBase64 } from "./file-utils"
import type { StoredFileMeta, StoredFileRecord } from "./types"

interface StoredValue {
  readonly id: string
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly createdAt: string
  readonly bytesBase64: string
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

const toMeta = (value: StoredValue): StoredFileMeta => ({
  id: value.id,
  filename: value.filename,
  mimeType: value.mimeType,
  sizeBytes: value.sizeBytes,
  createdAt: value.createdAt,
})

export class FileStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "POST" && url.pathname === "/put") {
      const body = await readJson(request)
      const id = crypto.randomUUID()
      const filename = typeof body.filename === "string" ? body.filename : `file-${Date.now()}`
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream"
      const bytesBase64 = typeof body.bytesBase64 === "string" ? body.bytesBase64 : ""
      const value: StoredValue = {
        id,
        filename,
        mimeType,
        sizeBytes: fromBase64(bytesBase64).byteLength,
        createdAt: new Date().toISOString(),
        bytesBase64,
      }
      await this.state.storage.put(`file:${id}`, value)
      return json({ file: toMeta(value) })
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

    return json({ error: "Not found" }, 404)
  }
}

export class DurableObjectFileStore {
  constructor(private readonly namespace: DurableObjectNamespace) {}

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
      }),
    })
    const payload = (await response.json()) as { file?: StoredFileMeta }
    if (!response.ok || !payload.file) throw new Error("DO put failed")
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
}
