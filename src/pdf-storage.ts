import type { FileStore, StoredFileMeta, StoredFileRecord } from "./types"

export class InMemoryFileStore implements FileStore {
  private readonly store = new Map<string, StoredFileRecord>()

  async put(input: {
    readonly filename: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<StoredFileMeta> {
    const id = crypto.randomUUID()
    const record: StoredFileRecord = {
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      createdAt: new Date().toISOString(),
      bytes: input.bytes,
    }
    this.store.set(id, record)
    return this.toMeta(record)
  }

  async get(fileId: string): Promise<StoredFileRecord | null> {
    return this.store.get(fileId) ?? null
  }

  async list(): Promise<ReadonlyArray<StoredFileMeta>> {
    return [...this.store.values()].map((record) => this.toMeta(record))
  }

  async delete(fileId: string): Promise<boolean> {
    return this.store.delete(fileId)
  }

  private toMeta(record: StoredFileRecord): StoredFileMeta {
    return {
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
    }
  }
}

export const runtimeFileStore = new InMemoryFileStore()
