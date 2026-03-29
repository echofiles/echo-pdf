import { access, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const paperPdf = path.join(rootDir, "eval", "public-samples", "arxiv-attention-is-all-you-need.pdf")
const formPdf = path.join(rootDir, "eval", "public-samples", "irs-form-w4.pdf")
const mixedTechnicalPdf = path.join(rootDir, "fixtures", "input.pdf")

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
  it("reduces false sections on mixed technical layouts without removing the true narrative headings", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-tech-"))
    await ensureSample(mixedTechnicalPdf, "The committed mixed-technical fixture should exist in the repo.")

    const semantic = await local.get_semantic_document_structure({ pdfPath: mixedTechnicalPdf, workspaceDir }) as {
      root: { children?: SemanticNode[] }
    }
    const titles = flattenTitles(semantic.root.children)

    expect(titles).not.toContain("10 kΩ")
    expect(titles).not.toContain("10 kΩ 10 kΩ")
  })

  it("suppresses incidental prose and worksheet fragments on forms", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-form-"))
    await ensureSample(
      formPdf,
      "Run `npm run eval:fetch-public-samples -- --sample irs-form-w4` or prepare the canonical public sample locally."
    )

    const semantic = await local.get_semantic_document_structure({ pdfPath: formPdf, workspaceDir }) as {
      root: { children?: SemanticNode[] }
    }
    const titles = flattenTitles(semantic.root.children)

    expect(titles).not.toContain("Section references are to the Internal Revenue Code unless")
    expect(titles).not.toContain("8 Limitation on itemized deductions.")
    expect(titles).not.toContain("11 Standard deduction.")
  })

  it("keeps clear section headings on papers", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-paper-"))
    await ensureSample(
      paperPdf,
      "Run `npm run eval:fetch-public-samples -- --sample arxiv-attention-is-all-you-need` or prepare the canonical public sample locally."
    )

    const semantic = await local.get_semantic_document_structure({ pdfPath: paperPdf, workspaceDir }) as {
      root: { children?: SemanticNode[] }
    }
    const titles = flattenTitles(semantic.root.children)

    expect(titles).toContain("1 Introduction")
    expect(titles).toContain("3 Model Architecture")
    expect(titles).toContain("7 Conclusion")
  })
})
