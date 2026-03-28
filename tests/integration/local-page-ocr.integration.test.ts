import { describe, expect, it } from "vitest"
import { copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = path.join(rootDir, "fixtures", "smoke.pdf")

const inferProvider = (): string => {
  if (typeof process.env.ECHO_PDF_TEST_OCR_PROVIDER === "string" && process.env.ECHO_PDF_TEST_OCR_PROVIDER.trim().length > 0) {
    return process.env.ECHO_PDF_TEST_OCR_PROVIDER.trim()
  }
  if (process.env.OPENAI_API_KEY) return "openai"
  if (process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY) return "openrouter"
  if (process.env.VERCEL_AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY) return "vercel_gateway"
  return ""
}

const provider = inferProvider()
const model = typeof process.env.ECHO_PDF_TEST_OCR_MODEL === "string" ? process.env.ECHO_PDF_TEST_OCR_MODEL.trim() : ""
const itWithOcrEnv = provider && model ? it : it.skip

describe("local page OCR artifacts", () => {
  itWithOcrEnv("writes and reuses OCR artifacts with a real provider", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-ocr-"))

    const first = await local.get_page_ocr({
      pdfPath: fixturePdf,
      workspaceDir,
      pageNumber: 1,
      provider,
      model,
    }) as {
      pageNumber: number
      provider: string
      model: string
      text: string
      cacheStatus: "fresh" | "reused"
      artifactPath: string
    }
    expect(first.pageNumber).toBe(1)
    expect(first.provider).toBe(provider)
    expect(first.model).toBe(model)
    expect(first.text.length).toBeGreaterThan(0)
    expect(first.cacheStatus).toBe("fresh")

    const second = await local.get_page_ocr({
      pdfPath: fixturePdf,
      workspaceDir,
      pageNumber: 1,
      provider,
      model,
    }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
    }
    expect(second.cacheStatus).toBe("reused")
    expect(second.artifactPath).toBe(first.artifactPath)
  })

  itWithOcrEnv("rebuilds OCR artifacts when the PDF changes at the same path", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-ocr-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-ocr-source-"))
    const sourcePdf = path.join(fixtureDir, "source.pdf")
    await copyFile(fixturePdf, sourcePdf)

    const first = await local.get_page_ocr({
      pdfPath: sourcePdf,
      workspaceDir,
      pageNumber: 1,
      provider,
      model,
    }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      sourceSizeBytes: number
      sourceMtimeMs: number
    }
    const originalBytes = await readFile(sourcePdf)
    await writeFile(sourcePdf, Buffer.concat([originalBytes, Buffer.from("\n% cache bust ocr\n", "utf-8")]))

    const sourceAfter = await stat(sourcePdf)
    const second = await local.get_page_ocr({
      pdfPath: sourcePdf,
      workspaceDir,
      pageNumber: 1,
      provider,
      model,
    }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      sourceSizeBytes: number
      sourceMtimeMs: number
    }
    const artifactAfter = await stat(second.artifactPath)

    expect(second.cacheStatus).toBe("fresh")
    expect(second.artifactPath).toBe(first.artifactPath)
    expect(second.sourceSizeBytes).toBe(sourceAfter.size)
    expect(second.sourceMtimeMs).toBe(sourceAfter.mtimeMs)
    expect(artifactAfter.size).toBeGreaterThan(0)
  })
})
