import { describe, expect, it } from "vitest"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeSimplePdf } from "../helpers/write-simple-pdf.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const smokePdf = path.join(rootDir, "fixtures", "smoke.pdf")

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
const model = typeof process.env.ECHO_PDF_TEST_SEMANTIC_MODEL === "string" && process.env.ECHO_PDF_TEST_SEMANTIC_MODEL.trim().length > 0
  ? process.env.ECHO_PDF_TEST_SEMANTIC_MODEL.trim()
  : (typeof process.env.ECHO_PDF_TEST_OCR_MODEL === "string" ? process.env.ECHO_PDF_TEST_OCR_MODEL.trim() : "")
const itWithSemanticEnv = provider && model ? it : it.skip

describe("local semantic document structure", () => {
  it("adds a semantic structure artifact without changing the page index contract", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-pdf-"))
    const semanticPdf = path.join(fixtureDir, "semantic.pdf")

    await writeSimplePdf(semanticPdf, [
      [
        "Document Guide",
        "1 Overview",
        "Overview body text",
        "1.1 Goals",
        "Goals body text",
      ],
      [
        "2 Usage",
        "Usage body text",
        "2.1 Commands",
        "Commands body text",
      ],
    ])

    const pageIndex = await local.get_document_structure({ pdfPath: semanticPdf, workspaceDir }) as {
      root: { children?: Array<{ type?: string; pageNumber?: number }> }
    }
    expect(pageIndex.root.children?.map((node) => node.type)).toEqual(["page", "page"])
    expect(pageIndex.root.children?.map((node) => node.pageNumber)).toEqual([1, 2])

    const semantic = await local.get_semantic_document_structure({ pdfPath: semanticPdf, workspaceDir }) as {
      cacheStatus: "fresh" | "reused"
      pageIndexArtifactPath: string
      artifactPath: string
      root: {
        children?: Array<{
          title?: string
          level?: number
          pageNumber?: number
          children?: Array<{ title?: string; level?: number; pageNumber?: number }>
        }>
      }
    }
    expect(semantic.cacheStatus).toBe("fresh")
    expect(semantic.pageIndexArtifactPath.endsWith("structure.json")).toBe(true)
    expect(semantic.artifactPath.endsWith("semantic-structure.json")).toBe(true)
    expect(semantic.root.children?.[0]).toMatchObject({
      title: "1 Overview",
      level: 1,
      pageNumber: 1,
    })
    expect(semantic.root.children?.[0]?.children?.[0]).toMatchObject({
      title: "1.1 Goals",
      level: 2,
      pageNumber: 1,
    })
    expect(semantic.root.children?.[1]).toMatchObject({
      title: "2 Usage",
      level: 1,
      pageNumber: 2,
    })
    expect(semantic.root.children?.[1]?.children?.[0]).toMatchObject({
      title: "2.1 Commands",
      level: 2,
      pageNumber: 2,
    })

    const semanticSecond = await local.get_semantic_document_structure({ pdfPath: semanticPdf, workspaceDir }) as {
      cacheStatus: "fresh" | "reused"
    }
    expect(semanticSecond.cacheStatus).toBe("reused")

    const semanticJson = JSON.parse(await readFile(semantic.artifactPath, "utf-8")) as {
      detector?: string
      root?: { children?: unknown[] }
    }
    expect(semanticJson.detector).toBe("heading-heuristic-v1")
    expect(Array.isArray(semanticJson.root?.children)).toBe(true)
  })

  it("returns an empty semantic structure when no headings are detectable", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-empty-"))

    const pageIndex = await local.get_document_structure({ pdfPath: smokePdf, workspaceDir }) as {
      root: { children?: unknown[] }
    }
    const semantic = await local.get_semantic_document_structure({ pdfPath: smokePdf, workspaceDir }) as {
      root: { children?: unknown[] }
    }

    expect(pageIndex.root.children?.length).toBe(1)
    expect(semantic.root.children ?? []).toHaveLength(0)
  })

  itWithSemanticEnv("prefers agent-native extraction when a local provider/model is configured", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-agent-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-agent-pdf-"))
    const semanticPdf = path.join(fixtureDir, "semantic-agent.pdf")

    await writeSimplePdf(semanticPdf, [
      [
        "Document Guide",
        "1 Overview",
        "Overview body text",
        "1.1 Goals",
        "Goals body text",
      ],
      [
        "2 Usage",
        "Usage body text",
        "2.1 Commands",
        "Commands body text",
      ],
    ])

    const config = JSON.parse(await readFile(path.join(rootDir, "echo-pdf.config.json"), "utf-8")) as {
      agent: {
        defaultProvider: string
        defaultModel: string
      }
    }
    config.agent.defaultProvider = provider
    config.agent.defaultModel = model

    const semantic = await local.get_semantic_document_structure({
      pdfPath: semanticPdf,
      workspaceDir,
      config,
    }) as {
      detector: string
      root: {
        children?: Array<{
          title?: string
          children?: Array<{ title?: string }>
        }>
      }
    }

    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.root.children?.[0]?.title).toBe("1 Overview")
    expect(semantic.root.children?.[0]?.children?.[0]?.title).toBe("1.1 Goals")
    expect(semantic.root.children?.[1]?.title).toBe("2 Usage")
  })
})
