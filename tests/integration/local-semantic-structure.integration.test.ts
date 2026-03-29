import { afterEach, describe, expect, it } from "vitest"
import { access, copyFile, cp, mkdtemp, readFile, symlink } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { writeSimplePdf } from "../helpers/write-simple-pdf.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const smokePdf = path.join(rootDir, "fixtures", "smoke.pdf")
const mixedTechnicalPdf = path.join(rootDir, "fixtures", "input.pdf")
const paperPdf = path.join(rootDir, "eval", "public-samples", "arxiv-attention-is-all-you-need.pdf")
const formPdf = path.join(rootDir, "eval", "public-samples", "irs-form-w4.pdf")

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
    throw new Error(`Missing semantic integration sample: ${pdfPath}. ${hint}`)
  }
}

const loadTestConfig = async (): Promise<{
  agent: {
    defaultProvider: string
    defaultModel: string
  }
}> => JSON.parse(await readFile(path.join(rootDir, "echo-pdf.config.json"), "utf-8")) as {
  agent: {
    defaultProvider: string
    defaultModel: string
  }
}

const startSemanticTestProvider = async (options?: {
  failAggregation?: boolean
}): Promise<{
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

    if (prompt.includes("You extract semantic heading candidates from one rendered PDF page.")) {
      const pageNumber = Number(prompt.match(/Page number: (\d+)/)?.[1] ?? "0")
      const response =
        pageNumber === 1
          ? { candidates: [{ title: "1 Overview", level: 1, excerpt: "1 Overview", confidence: 0.95 }] }
          : { candidates: [{ title: "2 Usage", level: 1, excerpt: "2 Usage", confidence: 0.94 }] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
      return
    }

    if (prompt.includes("You assemble semantic document structure from page-understanding heading candidates.")) {
      if (options?.failAggregation) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "aggregation failed for test" }))
        return
      }
      const response = {
        sections: [
          { title: "1 Overview", level: 1, pageNumber: 1, excerpt: "1 Overview", children: [] },
          { title: "2 Usage", level: 1, pageNumber: 2, excerpt: "2 Usage", children: [] },
        ],
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
      return
    }

    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "unexpected prompt" }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("semantic test provider did not bind a TCP port")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

const semanticTestServers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (semanticTestServers.length > 0) {
    const close = semanticTestServers.pop()
    if (close) await close()
  }
})

describe("local semantic document structure", () => {
  it("supports the built semantic runtime from a dist checkout", async () => {
    const checkoutDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-built-semantic-"))
    await cp(path.join(rootDir, "dist"), path.join(checkoutDir, "dist"), { recursive: true })
    await copyFile(path.join(rootDir, "package.json"), path.join(checkoutDir, "package.json"))
    await copyFile(path.join(rootDir, "echo-pdf.config.json"), path.join(checkoutDir, "echo-pdf.config.json"))
    await symlink(path.join(rootDir, "node_modules"), path.join(checkoutDir, "node_modules"), "dir")

    const local = await import(pathToFileURL(path.join(checkoutDir, "dist", "local", "index.js")).href)
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-built-semantic-ws-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-built-semantic-pdf-"))
    const semanticPdf = path.join(fixtureDir, "built-semantic.pdf")

    await writeSimplePdf(semanticPdf, [
      ["Document Guide", "1 Overview", "Overview body text"],
      ["2 Usage", "Usage body text"],
    ])

    const semantic = await local.get_semantic_document_structure({ pdfPath: semanticPdf, workspaceDir }) as {
      detector: string
      root: { children?: Array<{ title?: string }> }
    }

    expect(semantic.detector).toBe("heading-heuristic-v1")
    expect(semantic.root.children?.map((node) => node.title)).toEqual(["1 Overview", "2 Usage"])
  })

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

  it("runs the page-understanding agent path in normal integration tests", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-ci-gate-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-ci-gate-pdf-"))
    const semanticPdf = path.join(fixtureDir, "semantic-ci-gate.pdf")
    await writeSimplePdf(semanticPdf, [
      ["Document Guide", "1 Overview", "Overview body text"],
      ["2 Usage", "Usage body text"],
    ])

    const providerServer = await startSemanticTestProvider()
    semanticTestServers.push(providerServer.close)
    const config = await loadTestConfig() as import("../../src/pdf-types.js").EchoPdfConfig
    const providerAlias = "semantic_test"
    const env = { ...process.env, ECHO_PDF_SEMANTIC_TEST_KEY: "test-key" } as import("../../src/types.js").Env
    const configWithProvider = {
      ...config,
      agent: {
        ...config.agent,
        defaultProvider: providerAlias,
        defaultModel: "semantic-test-model",
      },
      providers: {
        ...config.providers,
        [providerAlias]: {
          type: "openai",
          apiKeyEnv: "ECHO_PDF_SEMANTIC_TEST_KEY",
          baseUrl: providerServer.baseUrl,
          endpoints: {
            chatCompletionsPath: "/chat/completions",
            modelsPath: "/models",
          },
        },
      },
    }

    const semantic = await local.get_semantic_document_structure({
      pdfPath: semanticPdf,
      workspaceDir,
      config: configWithProvider,
      provider: providerAlias,
      model: "semantic-test-model",
      env,
    }) as {
      detector: string
      strategyKey: string
      fallback?: { from: string; to: string; reason: string }
      root: { children?: Array<{ title?: string }> }
    }

    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.strategyKey).toContain("page-understanding-v1")
    expect(semantic.fallback).toBeUndefined()
    expect(semantic.root.children?.map((node) => node.title)).toEqual(["1 Overview", "2 Usage"])
  })

  it("makes heuristic fallback explicit when the agent semantic path fails", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-fallback-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-fallback-pdf-"))
    const semanticPdf = path.join(fixtureDir, "semantic-fallback.pdf")
    await writeSimplePdf(semanticPdf, [
      ["Document Guide", "1 Overview", "Overview body text"],
      ["2 Usage", "Usage body text"],
    ])

    const providerServer = await startSemanticTestProvider({ failAggregation: true })
    semanticTestServers.push(providerServer.close)
    const config = await loadTestConfig() as import("../../src/pdf-types.js").EchoPdfConfig
    const providerAlias = "semantic_test"
    const env = { ...process.env, ECHO_PDF_SEMANTIC_TEST_KEY: "test-key" } as import("../../src/types.js").Env
    const configWithProvider = {
      ...config,
      agent: {
        ...config.agent,
        defaultProvider: providerAlias,
        defaultModel: "semantic-test-model",
      },
      providers: {
        ...config.providers,
        [providerAlias]: {
          type: "openai",
          apiKeyEnv: "ECHO_PDF_SEMANTIC_TEST_KEY",
          baseUrl: providerServer.baseUrl,
          endpoints: {
            chatCompletionsPath: "/chat/completions",
            modelsPath: "/models",
          },
        },
      },
    }

    const semantic = await local.get_semantic_document_structure({
      pdfPath: semanticPdf,
      workspaceDir,
      config: configWithProvider,
      provider: providerAlias,
      model: "semantic-test-model",
      env,
    }) as {
      detector: string
      strategyKey: string
      fallback?: { from: string; to: string; reason: string }
      root: { children?: Array<{ title?: string }> }
    }

    expect(semantic.detector).toBe("heading-heuristic-v1")
    expect(semantic.strategyKey).toContain("agent-fallback::page-understanding-v1")
    expect(semantic.fallback).toMatchObject({
      from: "agent-structured-v1",
      to: "heading-heuristic-v1",
    })
    expect(semantic.fallback?.reason).toContain("Text generation request failed: HTTP 500")
    expect(semantic.root.children?.map((node) => node.title)).toEqual(["1 Overview", "2 Usage"])
  })

  itWithSemanticEnv("uses runtime provider/model overrides instead of config defaults", async () => {
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

    const config = await loadTestConfig()
    config.agent.defaultProvider = "openai"
    config.agent.defaultModel = ""

    const semantic = await local.get_semantic_document_structure({
      pdfPath: semanticPdf,
      workspaceDir,
      config,
      provider,
      model,
    }) as {
      detector: string
      strategyKey: string
      root: {
        children?: Array<{
          title?: string
          children?: Array<{ title?: string }>
        }>
      }
    }

    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.strategyKey).toContain(`::${provider}::${model}`)
    expect(semantic.root.children?.[0]?.title).toBe("1 Overview")
    expect(semantic.root.children?.[0]?.children?.[0]?.title).toBe("1.1 Goals")
    expect(semantic.root.children?.[1]?.title).toBe("2 Usage")
  })

  itWithSemanticEnv("keeps later page headings visible to the agent path", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-late-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-late-pdf-"))
    const semanticPdf = path.join(fixtureDir, "semantic-late.pdf")
    const filler = Array.from({ length: 36 }, (_, index) => `Body filler line ${index + 1}`)

    await writeSimplePdf(semanticPdf, [[
      "Document Guide",
      ...filler,
      "2 Deep Heading",
      "Late heading body text",
    ]])

    const config = await loadTestConfig()
    config.agent.defaultProvider = "openai"
    config.agent.defaultModel = ""

    const semantic = await local.get_semantic_document_structure({
      pdfPath: semanticPdf,
      workspaceDir,
      config,
      provider,
      model,
    }) as {
      detector: string
      root: {
        children?: Array<{
          title?: string
        }>
      }
    }

    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.root.children?.some((node) => node.title?.includes("Deep Heading"))).toBe(true)
  })

  itWithSemanticEnv("uses budgeted chunk extraction instead of falling back on long multi-page inputs", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-budget-"))
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-budget-pdf-"))
    const semanticPdf = path.join(fixtureDir, "semantic-budget.pdf")
    const longFiller = Array.from({ length: 80 }, (_, index) => `Long body paragraph ${index + 1} with repeated text to consume prompt budget.`)

    await writeSimplePdf(semanticPdf, [
      [
        "Document Guide",
        ...longFiller.slice(0, 40),
        "3 Late Page Heading",
        "Late page heading body",
      ],
      [
        "Continuation",
        ...longFiller.slice(40),
        "4 Final Section",
        "Final section body",
      ],
    ])

    const config = await loadTestConfig()
    config.agent.defaultProvider = "openai"
    config.agent.defaultModel = ""

    const semantic = await local.get_semantic_document_structure({
      pdfPath: semanticPdf,
      workspaceDir,
      config,
      provider,
      model,
      semanticExtraction: {
        pageSelection: "all",
        chunkMaxChars: 500,
        chunkOverlapChars: 120,
      },
    }) as {
      detector: string
      strategyKey: string
      root: {
        children?: Array<{
          title?: string
        }>
      }
    }

    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.strategyKey).toContain("page-understanding-v1")
    expect(semantic.strategyKey).toContain("::all::500::120")
    expect(semantic.root.children?.some((node) => node.title?.includes("Late Page Heading"))).toBe(true)
    expect(semantic.root.children?.some((node) => node.title?.includes("Final Section"))).toBe(true)
  })

  itWithSemanticEnv("uses the page-understanding agent path on real PDFs while reducing datasheet/form noise", async () => {
    await ensureSample(mixedTechnicalPdf, "The committed mixed-technical fixture should exist in the repo.")
    await ensureSample(
      paperPdf,
      "Run `npm run eval:fetch-public-samples -- --sample arxiv-attention-is-all-you-need` before this integration test."
    )
    await ensureSample(
      formPdf,
      "Run `npm run eval:fetch-public-samples -- --sample irs-form-w4` before this integration test."
    )

    const local = await import("@echofiles/echo-pdf/local")
    const config = await loadTestConfig()
    config.agent.defaultProvider = "openai"
    config.agent.defaultModel = ""

    const flattenTitles = (nodes: Array<{ title?: string; children?: unknown[] }> | undefined): string[] => {
      if (!Array.isArray(nodes)) return []
      return nodes.flatMap((node) => {
        const title = typeof node.title === "string" ? [node.title] : []
        return [...title, ...flattenTitles(node.children as Array<{ title?: string; children?: unknown[] }> | undefined)]
      })
    }

    const mixed = await local.get_semantic_document_structure({
      pdfPath: mixedTechnicalPdf,
      workspaceDir: await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-real-tech-")),
      config,
      provider,
      model,
    }) as {
      detector: string
      strategyKey: string
      root: { children?: Array<{ title?: string; children?: unknown[] }> }
    }
    const form = await local.get_semantic_document_structure({
      pdfPath: formPdf,
      workspaceDir: await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-real-form-")),
      config,
      provider,
      model,
    }) as {
      detector: string
      strategyKey: string
      root: { children?: Array<{ title?: string; children?: unknown[] }> }
    }
    const paper = await local.get_semantic_document_structure({
      pdfPath: paperPdf,
      workspaceDir: await mkdtemp(path.join(os.tmpdir(), "echo-pdf-semantic-real-paper-")),
      config,
      provider,
      model,
    }) as {
      detector: string
      strategyKey: string
      root: { children?: Array<{ title?: string; children?: unknown[] }> }
    }

    const mixedTitles = flattenTitles(mixed.root.children)
    const formTitles = flattenTitles(form.root.children)
    const paperTitles = flattenTitles(paper.root.children)

    expect(mixed.detector).toBe("agent-structured-v1")
    expect(mixed.strategyKey).toContain("page-understanding-v1")
    expect(form.strategyKey).toContain("page-understanding-v1")
    expect(paper.strategyKey).toContain("page-understanding-v1")

    expect(mixedTitles).not.toContain("10 kΩ")
    expect(mixedTitles).not.toContain("10 kΩ 10 kΩ")
    expect(formTitles).not.toContain("Section references are to the Internal Revenue Code unless")
    expect(formTitles).not.toContain("8 Limitation on itemized deductions.")
    expect(formTitles).not.toContain("11 Standard deduction.")
    expect(paperTitles).toContain("1 Introduction")
    expect(paperTitles).toContain("3 Model Architecture")
    expect(paperTitles).toContain("7 Conclusion")
  })
})
