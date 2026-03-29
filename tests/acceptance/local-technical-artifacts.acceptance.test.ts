import { createServer } from "node:http"
import { access, mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const technicalPdf = path.join(rootDir, "fixtures", "input.pdf")
const paperPdf = path.join(rootDir, "eval", "public-samples", "arxiv-attention-is-all-you-need.pdf")

const ensureInput = async (pdfPath: string, hint: string): Promise<void> => {
  try {
    await access(pdfPath)
  } catch {
    throw new Error(`Missing acceptance PDF: ${pdfPath}. ${hint}`)
  }
}

const buildTestConfig = (baseUrl: string) => ({
  service: {
    name: "echo-pdf",
    publicBaseUrl: "https://echo-pdf.echofilesai.workers.dev",
    fileGet: { cacheTtlSeconds: 300 },
    maxPdfBytes: 10000000,
    maxPagesPerRequest: 20,
    defaultRenderScale: 2,
    storage: {
      maxFileBytes: 10000000,
      maxTotalBytes: 52428800,
      ttlHours: 24,
      cleanupBatchSize: 50,
    },
  },
  pdfium: {
    wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm",
  },
  agent: {
    defaultProvider: "openai",
    defaultModel: "",
    ocrPrompt: "unused",
    tablePrompt: "unused",
  },
  providers: {
    openai: {
      type: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl,
      endpoints: {
        chatCompletionsPath: "/chat/completions",
        modelsPath: "/models",
      },
    },
  },
  mcp: {
    serverName: "echo-pdf-mcp",
    version: "0.1.0",
    authHeader: "x-mcp-key",
    authEnv: "ECHO_PDF_MCP_KEY",
  },
})

const startStructuredArtifactsProvider = async (): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
      messages?: Array<{ content?: string | Array<{ type?: string; text?: string }> }>
    }
    const content = payload.messages?.[0]?.content
    const prompt = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text ?? "")
          .join("\n")
        : ""

    let body: unknown = { tables: [] }
    if (prompt.includes("structured table artifacts")) {
      body = prompt.includes("Maximum path lengths")
        ? {
            tables: [{
              latexTabular: "\\begin{tabular}{lccc}\nLayer Type & Complexity per Layer & Sequential Operations & Maximum Path Length\\\\\nSelf-Attention & O(n^2 \\cdot d) & O(1) & O(1)\\\\\nRecurrent & O(n \\cdot d^2) & O(n) & O(n)\\\\\n\\end{tabular}",
              caption: "Table 1",
              evidenceText: "Maximum path lengths, per-layer complexity and minimum number of sequential operations",
            }],
          }
        : { tables: [] }
    } else if (prompt.includes("structured formula artifacts")) {
      body = prompt.includes("Attention(Q, K, V ) = softmax")
        ? {
            formulas: [{
              latexMath: "Attention(Q, K, V) = \\operatorname{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V",
              label: "(1)",
              evidenceText: "Attention(Q, K, V ) = softmax",
            }],
          }
        : (prompt.includes("Differential Amplifier With Rail-to-Rail Output") || prompt.includes("rail-to-rail output signal is calculated"))
          ? {
              formulas: [{
                latexMath: "U_{OUT} = \\left(1 + \\frac{R_2}{R_G}\\right) U_{IN} + U_{REF}",
                label: "(4)",
                evidenceText: "The rail-to-rail output signal is calculated using the following equation",
              }],
            }
          : { formulas: [] }
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("structured artifact provider did not bind a TCP port")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

const providerClosers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (providerClosers.length > 0) {
    const close = providerClosers.pop()
    if (close) await close()
  }
})

describe("technical latex artifacts on real PDFs", () => {
  it("materializes LaTeX tabular artifacts from a real paper table page", async () => {
    await ensureInput(
      paperPdf,
      "Run `npm run eval:fetch-public-samples -- --sample arxiv-attention-is-all-you-need` to prepare the canonical public sample."
    )
    const provider = await startStructuredArtifactsProvider()
    providerClosers.push(provider.close)
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-tables-"))
    const config = buildTestConfig(provider.baseUrl)

    const first = await local.get_page_tables_latex({
      pdfPath: paperPdf,
      workspaceDir,
      pageNumber: 6,
      config,
      provider: "openai",
      model: "structured-test-model",
      env: { ...process.env, OPENAI_API_KEY: "test-key" },
    }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
      pageArtifactPath: string
      renderArtifactPath: string
      tables: Array<{ latexTabular: string; caption?: string; evidenceText?: string }>
    }

    const second = await local.get_page_tables_latex({
      pdfPath: paperPdf,
      workspaceDir,
      pageNumber: 6,
      config,
      provider: "openai",
      model: "structured-test-model",
      env: { ...process.env, OPENAI_API_KEY: "test-key" },
    }) as {
      cacheStatus: "fresh" | "reused"
      artifactPath: string
    }

    expect(first.cacheStatus).toBe("fresh")
    expect(second.cacheStatus).toBe("reused")
    expect(first.tables).toHaveLength(1)
    expect(first.tables[0]?.latexTabular).toContain("\\begin{tabular}")
    expect(first.tables[0]?.caption).toContain("Table 1")
    expect(first.tables[0]?.evidenceText).toContain("Maximum path lengths")
    expect(first.pageArtifactPath.endsWith(path.join("pages", "0006.json"))).toBe(true)
    expect(first.renderArtifactPath.endsWith(path.join("renders", "0006.scale-2.json"))).toBe(true)
    const stored = JSON.parse(await readFile(first.artifactPath, "utf-8")) as {
      tables?: Array<{ latexTabular?: string }>
    }
    expect(stored.tables?.[0]?.latexTabular).toContain("\\begin{tabular}")
  })

  it("materializes LaTeX math artifacts from real paper and technical-document pages", async () => {
    await ensureInput(
      paperPdf,
      "Run `npm run eval:fetch-public-samples -- --sample arxiv-attention-is-all-you-need` to prepare the canonical public sample."
    )
    await ensureInput(technicalPdf, "The committed technical fixture should exist in the repo.")
    const provider = await startStructuredArtifactsProvider()
    providerClosers.push(provider.close)
    const local = await import("@echofiles/echo-pdf/local")
    const config = buildTestConfig(provider.baseUrl)

    const paper = await local.get_page_formulas_latex({
      pdfPath: paperPdf,
      workspaceDir: await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-formula-paper-")),
      pageNumber: 4,
      config,
      provider: "openai",
      model: "structured-test-model",
      env: { ...process.env, OPENAI_API_KEY: "test-key" },
    }) as {
      formulas: Array<{ latexMath: string; label?: string }>
      pageArtifactPath: string
    }
    const technical = await local.get_page_formulas_latex({
      pdfPath: technicalPdf,
      workspaceDir: await mkdtemp(path.join(os.tmpdir(), "echo-pdf-accept-formula-tech-")),
      pageNumber: 13,
      config,
      provider: "openai",
      model: "structured-test-model",
      env: { ...process.env, OPENAI_API_KEY: "test-key" },
    }) as {
      formulas: Array<{ latexMath: string; label?: string; evidenceText?: string }>
      artifactPath: string
      pageArtifactPath: string
      renderArtifactPath: string
    }

    expect(paper.formulas[0]?.latexMath).toContain("\\operatorname{softmax}")
    expect(paper.formulas[0]?.label).toBe("(1)")
    expect(paper.pageArtifactPath.endsWith(path.join("pages", "0004.json"))).toBe(true)
    expect(technical.formulas[0]?.latexMath).toContain("U_{OUT}")
    expect(technical.formulas[0]?.label).toBe("(4)")
    expect(technical.formulas[0]?.evidenceText).toContain("following equation")
    expect(technical.pageArtifactPath.endsWith(path.join("pages", "0013.json"))).toBe(true)
    expect(technical.renderArtifactPath.endsWith(path.join("renders", "0013.scale-2.json"))).toBe(true)
    const stored = JSON.parse(await readFile(technical.artifactPath, "utf-8")) as {
      formulas?: Array<{ latexMath?: string }>
    }
    expect(stored.formulas?.[0]?.latexMath).toContain("U_{OUT}")
  })
})
