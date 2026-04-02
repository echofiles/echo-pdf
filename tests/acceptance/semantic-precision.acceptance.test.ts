import { access, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { publicSamplePaths, repoOwnedSamplePaths } from "../../samples/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const paperPdf = publicSamplePaths.attentionPaperPdf
const formPdf = publicSamplePaths.irsFormW4Pdf
const mixedTechnicalPdf = repoOwnedSamplePaths.inputPdf

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

const ensureSample = async (pdfPath: string, hint: string): Promise<void> => {
  try {
    await access(pdfPath)
  } catch {
    throw new Error(`Missing semantic precision sample: ${pdfPath}. ${hint}`)
  }
}

type SemanticNode = {
  title?: string
  children?: SemanticNode[]
}

const flattenTitles = (nodes: readonly SemanticNode[] | undefined): string[] => {
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((node) => {
    const title = typeof node.title === "string" ? [node.title] : []
    return [...title, ...flattenTitles(node.children)]
  })
}

describe("semantic precision on real PDFs", () => {
  itWithSemanticEnv("reduces false sections on mixed technical layouts without removing the true narrative headings", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-tech-"))
    await ensureSample(mixedTechnicalPdf, "The committed mixed-technical fixture should exist in the repo.")

    const semantic = await local.get_semantic_document_structure({ pdfPath: mixedTechnicalPdf, workspaceDir, provider, model }) as {
      root: { children?: SemanticNode[] }
    }
    const titles = flattenTitles(semantic.root.children)

    expect(titles).not.toContain("10 kΩ")
    expect(titles).not.toContain("10 kΩ 10 kΩ")
    expect(titles).not.toContain("1.6 kΩ")
  })

  itWithSemanticEnv("suppresses incidental prose and worksheet fragments on forms", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-form-"))
    await ensureSample(
      formPdf,
      "Run `bun run eval:fetch-public-samples -- --sample irs-form-w4` or prepare the shared public sample cache locally."
    )

    const semantic = await local.get_semantic_document_structure({ pdfPath: formPdf, workspaceDir, provider, model }) as {
      root: { children?: SemanticNode[] }
    }
    const titles = flattenTitles(semantic.root.children)

    expect(titles).not.toContain("Section references are to the Internal Revenue Code unless")
    expect(titles).not.toContain("8 Limitation on itemized deductions.")
    expect(titles).not.toContain("11 Standard deduction.")
  })

  itWithSemanticEnv("keeps clear section headings on papers", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-paper-"))
    await ensureSample(
      paperPdf,
      "Run `bun run eval:fetch-public-samples -- --sample arxiv-attention-is-all-you-need` or prepare the shared public sample cache locally."
    )

    const semantic = await local.get_semantic_document_structure({ pdfPath: paperPdf, workspaceDir, provider, model }) as {
      root: { children?: SemanticNode[] }
    }
    const titles = flattenTitles(semantic.root.children)

    expect(titles).toContain("1 Introduction")
    expect(titles).toContain("3 Model Architecture")
    expect(titles).toContain("7 Conclusion")
  })
})
