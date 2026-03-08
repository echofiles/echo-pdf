import { describe, expect, it } from "vitest"
import { runFileOp } from "../../src/file-ops"
import type { FileStore, StoredFileMeta, StoredFileRecord } from "../../src/types"

class TestStore implements FileStore {
  private readonly records = new Map<string, StoredFileRecord>()
  private counter = 0

  async put(input: {
    readonly filename: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<StoredFileMeta> {
    this.counter += 1
    const id = `file-${this.counter}`
    const record: StoredFileRecord = {
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      createdAt: new Date().toISOString(),
      bytes: input.bytes,
    }
    this.records.set(id, record)
    return {
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
    }
  }

  async get(fileId: string): Promise<StoredFileRecord | null> {
    return this.records.get(fileId) ?? null
  }

  async list(): Promise<ReadonlyArray<StoredFileMeta>> {
    return [...this.records.values()].map((record) => ({
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
    }))
  }

  async delete(fileId: string): Promise<boolean> {
    return this.records.delete(fileId)
  }
}

describe("runFileOp", () => {
  it("puts, reads, lists and deletes files", async () => {
    const store = new TestStore()

    const putResult = await runFileOp(store, {
      op: "put",
      filename: "smoke.txt",
      mimeType: "text/plain",
      text: "hello",
      returnMode: "file_id",
    })
    const fileId = (putResult as { file?: { id?: string } }).file?.id
    expect(fileId).toBeTruthy()

    const readResult = await runFileOp(store, {
      op: "read",
      fileId,
      includeBase64: false,
    })
    expect((readResult as { text?: string }).text).toBe("hello")

    const listResult = await runFileOp(store, { op: "list" })
    expect(Array.isArray((listResult as { files?: unknown[] }).files)).toBe(true)

    const deleteResult = await runFileOp(store, { op: "delete", fileId })
    expect((deleteResult as { deleted?: boolean }).deleted).toBe(true)
  })
})
