import { describe, expect, it } from "vitest"
import { copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
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
        rendersDir: string
        ocrDir: string
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

    const render = await local.get_page_render({ pdfPath: fixturePdf, workspaceDir, pageNumber: 1 }) as {
      pageNumber: number
      mimeType: string
      imagePath: string
      artifactPath: string
      cacheStatus: "fresh" | "reused"
    }
    expect(render.pageNumber).toBe(1)
    expect(render.mimeType).toBe("image/png")
    expect(render.imagePath.startsWith(first.artifactPaths.rendersDir)).toBe(true)
    expect(render.cacheStatus).toBe("fresh")

    const structureBefore = await stat(first.artifactPaths.structureJsonPath)
    const renderBefore = await stat(render.artifactPath)
    const second = await local.get_document({ pdfPath: fixturePdf, workspaceDir }) as {
      cacheStatus: "fresh" | "reused"
    }
    const structureAfter = await stat(first.artifactPaths.structureJsonPath)
    const renderSecond = await local.get_page_render({ pdfPath: fixturePdf, workspaceDir, pageNumber: 1 }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
    }
    const renderAfter = await stat(renderSecond.artifactPath)
    expect(second.cacheStatus).toBe("reused")
    expect(structureAfter.mtimeMs).toBe(structureBefore.mtimeMs)
    expect(renderSecond.cacheStatus).toBe("reused")
    expect(renderAfter.mtimeMs).toBe(renderBefore.mtimeMs)

    const documentJson = JSON.parse(await readFile(first.artifactPaths.documentJsonPath, "utf-8")) as {
      documentId?: string
    }
    expect(documentJson.documentId).toBe(first.documentId)
  })

  it("rebuilds page render artifacts when the PDF changes at the same path", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-local-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-source-"))
    const sourcePdf = path.join(fixtureDir, "source.pdf")
    await copyFile(fixturePdf, sourcePdf)

    const first = await local.get_page_render({ pdfPath: sourcePdf, workspaceDir, pageNumber: 1 }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      sourceSizeBytes: number
      sourceMtimeMs: number
    }
    const artifactBefore = await stat(first.artifactPath)
    const originalBytes = await readFile(sourcePdf)
    await writeFile(sourcePdf, Buffer.concat([originalBytes, Buffer.from("\n% cache bust render\n", "utf-8")]))

    const sourceAfter = await stat(sourcePdf)
    expect(sourceAfter.size).toBeGreaterThan(first.sourceSizeBytes)

    const second = await local.get_page_render({ pdfPath: sourcePdf, workspaceDir, pageNumber: 1 }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      sourceSizeBytes: number
      sourceMtimeMs: number
    }
    const artifactAfter = await stat(second.artifactPath)

    expect(second.cacheStatus).toBe("fresh")
    expect(second.sourceSizeBytes).toBe(sourceAfter.size)
    expect(second.sourceMtimeMs).toBe(sourceAfter.mtimeMs)
    expect(artifactAfter.mtimeMs).toBeGreaterThanOrEqual(artifactBefore.mtimeMs)
  })
})
