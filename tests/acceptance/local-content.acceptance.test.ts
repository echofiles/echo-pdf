import { execFile } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const inputPdf = path.join(rootDir, "fixtures", "input.pdf")
const arxivPdf = path.join(rootDir, "eval", "public-samples", "arxiv-attention-is-all-you-need.pdf")

const normalizeText = (value: string): string =>
  value
    .replace(/\r/g, "\n")
    .replace(/[^\p{L}\p{N}\n ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

const readPdftotextPage = async (pdfPath: string, pageNumber: number): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-f", String(pageNumber), "-l", String(pageNumber), pdfPath, "-"], {
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|not found/i.test(message)) return null
    throw error
  }
}

type SemanticNode = {
  title?: string
  pageNumber?: number
  pageArtifactPath?: string
  children?: SemanticNode[]
}

const flattenSemanticNodes = (nodes: readonly SemanticNode[] | undefined): SemanticNode[] => {
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((node) => [node, ...flattenSemanticNodes(node.children)])
}

describe("content-level acceptance on real local PDFs", () => {
  it("extracts useful selected-page text from a real PDF and keeps the page artifact inspectable", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-page-"))

    const structure = await local.get_document_structure({ pdfPath: inputPdf, workspaceDir }) as {
      root: { children?: Array<{ pageNumber?: number; artifactPath?: string }> }
    }
    const first = await local.get_page_content({ pdfPath: inputPdf, workspaceDir, pageNumber: 1 }) as {
      pageNumber: number
      title: string
      text: string
      artifactPath: string
    }
    const second = await local.get_page_content({ pdfPath: inputPdf, workspaceDir, pageNumber: 1 }) as {
      text: string
      artifactPath: string
    }

    expect(first.pageNumber).toBe(1)
    expect(first.title).toContain("Application Report")
    expect(first.artifactPath.endsWith(path.join("pages", "0001.json"))).toBe(true)
    expect(structure.root.children?.[0]?.pageNumber).toBe(1)
    expect(structure.root.children?.[0]?.artifactPath).toBe(first.artifactPath)
    expect(first.text).toContain("Application of Rail-to-Rail Operational Amplifiers")
    expect(first.text).toContain("This application report assists design engineers")
    expect(first.text).toContain("Dynamic Range and SNR in Low Single Supply Systems")
    expect(second.artifactPath).toBe(first.artifactPath)
    expect(second.text).toBe(first.text)

    const artifact = JSON.parse(await readFile(first.artifactPath, "utf-8")) as {
      pageNumber?: number
      text?: string
    }
    expect(artifact.pageNumber).toBe(1)
    expect(typeof artifact.text).toBe("string")

    const baseline = await readPdftotextPage(inputPdf, 1)
    if (baseline) {
      const normalizedBaseline = normalizeText(baseline)
      const normalizedPage = normalizeText(first.text)
      for (const anchor of [
        "application of rail to rail operational amplifiers",
        "this application report assists design engineers",
        "dynamic range and snr in low single supply systems",
      ]) {
        expect(normalizedBaseline).toContain(anchor)
        expect(normalizedPage).toContain(anchor)
      }
    }
  })

  it("surfaces real semantic headings from a local PDF instead of requiring layout noise to pass", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-semantic-"))

    const first = await local.get_semantic_document_structure({ pdfPath: arxivPdf, workspaceDir }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      pageIndexArtifactPath: string
      root: { children?: SemanticNode[] }
    }
    const second = await local.get_semantic_document_structure({ pdfPath: arxivPdf, workspaceDir }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      root: { children?: SemanticNode[] }
    }

    const semanticNodes = flattenSemanticNodes(first.root.children)
    const titles = semanticNodes.map((node) => node.title).filter((value): value is string => typeof value === "string")

    expect(first.cacheStatus).toBe("fresh")
    expect(second.cacheStatus).toBe("reused")
    expect(second.artifactPath).toBe(first.artifactPath)
    expect(first.pageIndexArtifactPath.endsWith("structure.json")).toBe(true)
    expect(titles).toContain("1 Introduction")
    expect(titles).toContain("3 Model Architecture")
    expect(titles).toContain("7 Conclusion")

    const introNode = semanticNodes.find((node) => node.title === "1 Introduction")
    expect(introNode?.pageNumber).toBe(2)
    expect(introNode?.pageArtifactPath?.endsWith(path.join("pages", "0002.json"))).toBe(true)

    const artifact = JSON.parse(await readFile(first.artifactPath, "utf-8")) as {
      root?: { children?: SemanticNode[] }
    }
    const artifactTitles = flattenSemanticNodes(artifact.root?.children)
      .map((node) => node.title)
      .filter((value): value is string => typeof value === "string")
    expect(artifactTitles).toContain("1 Introduction")
    expect(artifactTitles).toContain("3 Model Architecture")

    const page2Baseline = await readPdftotextPage(arxivPdf, 2)
    const page10Baseline = await readPdftotextPage(arxivPdf, 10)
    if (page2Baseline && page10Baseline) {
      expect(normalizeText(page2Baseline)).toContain("1 introduction")
      expect(normalizeText(page2Baseline)).toContain("3 model architecture")
      expect(normalizeText(page10Baseline)).toContain("7 conclusion")
    }
  })
})
