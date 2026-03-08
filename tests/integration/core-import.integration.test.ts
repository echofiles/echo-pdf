import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import configJson from "../../echo-pdf.config.json"
import type { EchoPdfConfig } from "../../src/pdf-types"
import type { Env, FileStore, StoredFileMeta, StoredFileRecord } from "../../src/types"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = path.join(rootDir, "fixtures", "smoke.pdf")
const localPdfiumWasm = path.join(rootDir, "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm")

class InMemoryFileStore implements FileStore {
  private readonly records = new Map<string, StoredFileRecord>()
  private seq = 0

  async put(input: {
    readonly filename: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<StoredFileMeta> {
    this.seq += 1
    const id = `mem-${this.seq}`
    const record: StoredFileRecord = {
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      createdAt: new Date().toISOString(),
      bytes: input.bytes,
    }
    this.records.set(id, record)
    return record
  }

  async get(fileId: string): Promise<StoredFileRecord | null> {
    return this.records.get(fileId) ?? null
  }

  async list(): Promise<ReadonlyArray<StoredFileMeta>> {
    return Array.from(this.records.values())
  }

  async delete(fileId: string): Promise<boolean> {
    return this.records.delete(fileId)
  }
}

describe("core import integration", () => {
  it("imports package exports and runs pdf_extract_pages without mocks", async () => {
    const core = await import("@echofiles/echo-pdf")
    const pdfExtractPages = core.pdf_extract_pages as (
      args: { fileId: string; pages: number[]; returnMode: "inline" },
      ctx: {
        config: EchoPdfConfig
        env: Env
        fileStore: FileStore
      }
    ) => Promise<unknown>

    expect(typeof pdfExtractPages).toBe("function")

    const fileStore = new InMemoryFileStore()
    const bytes = new Uint8Array(await readFile(fixturePdf))
    const stored = await fileStore.put({
      filename: "smoke.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    const wasmBytes = await readFile(localPdfiumWasm)
    const config = {
      ...configJson,
      pdfium: {
        ...configJson.pdfium,
        wasmUrl: `data:application/wasm;base64,${wasmBytes.toString("base64")}`,
      },
    } as EchoPdfConfig

    const result = await pdfExtractPages(
      { fileId: stored.id, pages: [1], returnMode: "inline" },
      {
        config,
        env: {} as Env,
        fileStore,
      }
    ) as {
      fileId: string
      images: Array<{ data?: string; mimeType?: string }>
    }

    expect(result.fileId).toBe(stored.id)
    expect(result.images.length).toBe(1)
    expect(result.images[0]?.mimeType).toBe("image/png")
    expect(result.images[0]?.data?.startsWith("data:image/png;base64,")).toBe(true)
  })
})
