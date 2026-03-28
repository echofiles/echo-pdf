import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = path.join(rootDir, "fixtures", "smoke.pdf")

describe("local document workflow", () => {
  it("indexes a PDF into inspectable local artifacts and reuses them", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-local-"))

    const first = await local.get_document({ pdfPath: fixturePdf, workspaceDir }) as {
      documentId: string
      pageCount: number
      cacheStatus: "fresh" | "reused"
      artifactPaths: {
        documentJsonPath: string
        structureJsonPath: string
        pagesDir: string
      }
    }
    expect(first.pageCount).toBeGreaterThan(0)
    expect(first.cacheStatus).toBe("fresh")

    const structure = await local.get_document_structure({ pdfPath: fixturePdf, workspaceDir }) as {
      documentId: string
      root: { children?: Array<{ pageNumber?: number; artifactPath?: string }> }
    }
    expect(structure.documentId).toBe(first.documentId)
    expect(structure.root.children?.length).toBe(first.pageCount)
    expect(structure.root.children?.[0]?.pageNumber).toBe(1)

    const page = await local.get_page_content({ pdfPath: fixturePdf, workspaceDir, pageNumber: 1 }) as {
      documentId: string
      pageNumber: number
      text: string
      artifactPath: string
    }
    expect(page.documentId).toBe(first.documentId)
    expect(page.pageNumber).toBe(1)
    expect(typeof page.text).toBe("string")

    const structureBefore = await stat(first.artifactPaths.structureJsonPath)
    const second = await local.get_document({ pdfPath: fixturePdf, workspaceDir }) as {
      cacheStatus: "fresh" | "reused"
    }
    const structureAfter = await stat(first.artifactPaths.structureJsonPath)
    expect(second.cacheStatus).toBe("reused")
    expect(structureAfter.mtimeMs).toBe(structureBefore.mtimeMs)

    const documentJson = JSON.parse(await readFile(first.artifactPaths.documentJsonPath, "utf-8")) as {
      documentId?: string
    }
    expect(documentJson.documentId).toBe(first.documentId)
  })
})
