import { DurableObjectFileStore } from "./file-store-do"
import { R2FileStore } from "./r2-file-store"
import type { EchoPdfConfig } from "./pdf-types"
import type { Env, FileStore, StoredFileMeta, StoredFileRecord } from "./types"

class InMemoryFileStore implements FileStore {
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

const fallbackStore = new InMemoryFileStore()

export interface RuntimeFileStoreBundle {
  readonly store: FileStore
  stats: () => Promise<unknown>
  cleanup: () => Promise<unknown>
}

export const getRuntimeFileStore = (env: Env, config: EchoPdfConfig): RuntimeFileStoreBundle => {
  if (env.FILE_STORE_BUCKET) {
    const store = new R2FileStore(env.FILE_STORE_BUCKET, config.service.storage)
    return {
      store,
      stats: async () => store.stats(),
      cleanup: async () => store.cleanup(),
    }
  }
  if (env.FILE_STORE_DO) {
    const store = new DurableObjectFileStore(env.FILE_STORE_DO, config.service.storage)
    return {
      store,
      stats: async () => store.stats(),
      cleanup: async () => store.cleanup(),
    }
  }

  return {
    store: fallbackStore,
    stats: async () => {
      const files = await fallbackStore.list()
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
      return {
        backend: "memory",
        policy: config.service.storage,
        stats: {
          fileCount: files.length,
          totalBytes,
        },
      }
    },
    cleanup: async () => ({
      backend: "memory",
      deletedExpired: 0,
      deletedEvicted: 0,
      stats: await (async () => {
        const files = await fallbackStore.list()
        return {
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        }
      })(),
    }),
  }
}
