import { afterEach, describe, expect, it } from "vitest"
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { repoOwnedSamplePaths } from "../../samples/index.js"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = repoOwnedSamplePaths.smokePdf
const realFixturePdf = repoOwnedSamplePaths.inputPdf
const systemNodeMajor = Number(
  execFileSync("node", ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf-8" }).trim()
)
const hasBun = (() => {
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf-8" }).trim().length > 0
  } catch {
    return false
  }
})()
const itWithNode20 = systemNodeMajor >= 20 ? it : it.skip
const itWithNode20AndBun = systemNodeMajor >= 20 && hasBun ? it : it.skip

const runCli = async (
  repoDir: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync("node", [path.join(repoDir, "bin", "echo-pdf.js"), ...args], {
    cwd: repoDir,
    env: { ...process.env, ...envOverrides },
  })
  return { stdout, stderr }
}

const runCliFailure = async (
  repoDir: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> => {
  try {
    await runCli(repoDir, args, envOverrides)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    }
  }
  throw new Error(`Expected CLI failure for args: ${args.join(" ")}`)
}

const startSemanticCliTestProvider = async (options?: {
  requireNoAuth?: boolean
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
    if (options?.requireNoAuth && typeof req.headers.authorization === "string" && req.headers.authorization.length > 0) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "authorization header should be absent for local no-auth provider" }))
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

    if (prompt.includes("Extract headings, tables, formulas")) {
      const pageNumber = Number(prompt.match(/Page number: (\d+)/)?.[1] ?? "0")
      const response = {
        candidates: pageNumber === 1
          ? [{ title: "1 Overview", level: 1, excerpt: "1 Overview", confidence: 0.96 }]
          : [],
        tables: [],
        formulas: [],
        figures: [],
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
      return
    }

    if (prompt.includes("You assemble semantic document structure from page-understanding heading candidates.")) {
      const response = {
        sections: [{ title: "1 Overview", level: 1, pageNumber: 1, excerpt: "1 Overview", children: [] }],
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
      return
    }

    if (prompt.includes("Analyze this rendered PDF page image")) {
      const response = {
        tables: [{ latexTabular: "\\begin{tabular}{cc}\na & b\\\\\n\\end{tabular}", caption: "Test Table", truncatedTop: false, truncatedBottom: false }],
        formulas: [{ latexMath: "E = mc^2", label: "eq:1", truncatedTop: false, truncatedBottom: false }],
        figures: [{ figureType: "diagram", caption: "Test Figure", description: "A test diagram", truncatedTop: false, truncatedBottom: false }],
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
      return
    }

    if (prompt.includes("tabular") || prompt.includes("table")) {
      const response = {
        tables: [{ latexTabular: "\\begin{tabular}{cc}\na & b\\\\\n\\end{tabular}", caption: "Test Table" }],
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
      return
    }

    if (prompt.includes("formula") || prompt.includes("math")) {
      const response = {
        formulas: [{ latexMath: "E = mc^2", label: "eq:1" }],
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
    throw new Error("semantic CLI test provider did not bind a TCP port")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

const semanticCliTestServers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (semanticCliTestServers.length > 0) {
    const close = semanticCliTestServers.pop()
    if (close) await close()
  }
})

const runSourceCheckoutCliDev = async (repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync("npm", ["run", "cli:dev", "--", ...args], {
    cwd: repoDir,
    env: process.env,
  })
  return { stdout, stderr }
}

const createBuiltCheckout = async (): Promise<string> => {
  const checkoutDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-built-checkout-"))
  await cp(path.join(rootDir, "bin"), path.join(checkoutDir, "bin"), { recursive: true })
  await cp(path.join(rootDir, "dist"), path.join(checkoutDir, "dist"), { recursive: true })
  await cp(path.join(rootDir, "echo-pdf.config.json"), path.join(checkoutDir, "echo-pdf.config.json"))
  await cp(path.join(rootDir, "package.json"), path.join(checkoutDir, "package.json"))
  await symlink(path.join(rootDir, "node_modules"), path.join(checkoutDir, "node_modules"), "dir")
  return checkoutDir
}

describe("local document CLI", () => {
  itWithNode20("reads a PDF through the zero-config local primitives", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-"))

    const { stdout: docRaw } = await runCli(rootDir, ["document", fixturePdf, "--workspace", workspaceDir])
    const doc = JSON.parse(docRaw) as {
      documentId: string
      pageCount: number
      cacheStatus: "fresh" | "reused"
      artifactPaths: {
        documentJsonPath: string
      }
    }
    expect(doc.pageCount).toBeGreaterThan(0)
    expect(doc.cacheStatus).toBe("fresh")

    const { stdout: structureRaw } = await runCli(rootDir, ["structure", fixturePdf, "--workspace", workspaceDir])
    const structure = JSON.parse(structureRaw) as {
      documentId: string
      root: {
        children?: Array<{ pageNumber?: number }>
      }
    }
    expect(structure.documentId).toBe(doc.documentId)
    expect(structure.root.children?.[0]?.pageNumber).toBe(1)

    const { stdout: pageRaw } = await runCli(rootDir, ["page", fixturePdf, "--page", "1", "--workspace", workspaceDir])
    const page = JSON.parse(pageRaw) as {
      documentId: string
      pageNumber: number
      text: string
    }
    expect(page.documentId).toBe(doc.documentId)
    expect(page.pageNumber).toBe(1)
    expect(typeof page.text).toBe("string")

    const { stdout: renderRaw } = await runCli(rootDir, ["render", fixturePdf, "--page", "1", "--workspace", workspaceDir])
    const render = JSON.parse(renderRaw) as {
      pageNumber: number
      mimeType: string
      imagePath: string
      cacheStatus: "fresh" | "reused"
    }
    expect(render.pageNumber).toBe(1)
    expect(render.mimeType).toBe("image/png")
    expect(["fresh", "reused"]).toContain(render.cacheStatus)

    const { stdout: docSecondRaw } = await runCli(rootDir, ["document", fixturePdf, "--workspace", workspaceDir])
    const docSecond = JSON.parse(docSecondRaw) as {
      cacheStatus: "fresh" | "reused"
    }
    expect(docSecond.cacheStatus).toBe("reused")

    const { stdout: renderSecondRaw } = await runCli(rootDir, ["render", fixturePdf, "--page", "1", "--workspace", workspaceDir])
    const renderSecond = JSON.parse(renderSecondRaw) as {
      cacheStatus: "fresh" | "reused"
      imagePath: string
    }
    expect(renderSecond.cacheStatus).toBe("reused")
    expect(renderSecond.imagePath).toBe(render.imagePath)

    const stored = JSON.parse(await readFile(doc.artifactPaths.documentJsonPath, "utf-8")) as {
      documentId?: string
    }
    expect(stored.documentId).toBe(doc.documentId)
  })

  itWithNode20("rejects zero-config semantic runs with setup guidance", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-semantic-missing-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-semantic-missing-"))

    const { stderr } = await runCliFailure(rootDir, ["semantic", fixturePdf, "--workspace", workspaceDir], {
      HOME: homeDir,
    })

    expect(stderr).toContain("semantic requires a configured model for provider")
    expect(stderr).toContain("echo-pdf model set --provider")
  })

  itWithNode20("prints help around the five top-level primitives only", async () => {
    const { stdout } = await runCli(rootDir, ["--help"])

    expect(stdout).toContain("Primary local primitive commands:")
    expect(stdout).toContain("  document <file.pdf>")
    expect(stdout).toContain("  structure <file.pdf>")
    expect(stdout).toContain("  semantic <file.pdf>")
    expect(stdout).toContain("  page <file.pdf> --page <N>")
    expect(stdout).toContain("  render <file.pdf> --page <N> [--scale N]")
    expect(stdout).not.toContain("document get <file.pdf>")
    expect(stdout).not.toContain("document structure <file.pdf>")
    expect(stdout).not.toContain("document semantic <file.pdf>")
  })

  itWithNode20("rejects the removed ocr command with migration-only guidance", async () => {
    const { stderr } = await runCliFailure(rootDir, ["ocr", fixturePdf, "--page", "1"])

    expect(stderr).toContain("`echo-pdf ocr` was removed from the first-class CLI surface.")
    expect(stderr).toContain("OCR is migration-only")
  })

  itWithNode20("rejects removed legacy document aliases with migration guidance", async () => {
    const { stderr } = await runCliFailure(rootDir, ["document", "get", fixturePdf])

    expect(stderr).toContain("Legacy `document get` was removed.")
    expect(stderr).toContain("Use `echo-pdf document <file.pdf>` instead.")
  })

  itWithNode20("uses profile provider/model/api-key config for the VL-first semantic path on a real PDF", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-semantic-"))
    const providerServer = await startSemanticCliTestProvider()
    semanticCliTestServers.push(providerServer.close)
    const env = {
      HOME: homeDir,
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: {
          defaultRenderScale: 2,
        },
        pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
        agent: {
          defaultProvider: "openai",
          defaultModel: "",
          tablePrompt: "unused",
        },
        providers: {
          openai: {
            type: "openai",
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: providerServer.baseUrl,
            endpoints: {
              chatCompletionsPath: "/chat/completions",
              modelsPath: "/models",
            },
          },
        },
      }),
    }

    await runCli(rootDir, ["provider", "set", "--provider", "openai", "--api-key", "test-key"], env)
    await runCli(rootDir, ["model", "set", "--provider", "openai", "--model", "semantic-test-model"], env)

    const { stdout, stderr } = await runCli(rootDir, ["semantic", realFixturePdf, "--workspace", workspaceDir], env)
    const semantic = JSON.parse(stdout) as {
      detector: string
      strategyKey: string
      root: { children?: Array<{ title?: string }> }
    }

    expect(stderr.trim()).toBe("")
    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.strategyKey).toContain("page-understanding-v1")
    expect(semantic.root.children?.[0]?.title).toBe("1 Overview")
  })

  itWithNode20("supports a local OpenAI-compatible provider without a dummy API key", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-local-provider-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-local-provider-"))
    const providerServer = await startSemanticCliTestProvider({ requireNoAuth: true })
    semanticCliTestServers.push(providerServer.close)
    const env = {
      HOME: homeDir,
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: {
          defaultRenderScale: 2,
        },
        pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
        agent: {
          defaultProvider: "ollama",
          defaultModel: "",
          tablePrompt: "unused",
        },
        providers: {
          ollama: {
            type: "openai-compatible",
            apiKeyEnv: "",
            baseUrl: providerServer.baseUrl,
            endpoints: {
              chatCompletionsPath: "/chat/completions",
              modelsPath: "/models",
            },
          },
        },
      }),
    }

    await runCli(rootDir, ["provider", "set", "--provider", "ollama", "--api-key", ""], env)
    await runCli(rootDir, ["model", "set", "--provider", "ollama", "--model", "llava:13b"], env)

    const { stdout, stderr } = await runCli(rootDir, ["semantic", realFixturePdf, "--workspace", workspaceDir, "--provider", "ollama"], env)
    const semantic = JSON.parse(stdout) as {
      detector: string
      root: { children?: Array<{ title?: string }> }
    }

    expect(stderr.trim()).toBe("")
    expect(semantic.detector).toBe("agent-structured-v1")
    expect(semantic.root.children?.[0]?.title).toBe("1 Overview")
  })

  itWithNode20("extracts LaTeX tables from a page via the tables CLI command", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-tables-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-tables-"))
    const providerServer = await startSemanticCliTestProvider()
    semanticCliTestServers.push(providerServer.close)
    const env = {
      HOME: homeDir,
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: { defaultRenderScale: 2 },
        pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
        agent: { defaultProvider: "openai", defaultModel: "", tablePrompt: "detect tables" },
        providers: {
          openai: {
            type: "openai",
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: providerServer.baseUrl,
            endpoints: { chatCompletionsPath: "/chat/completions", modelsPath: "/models" },
          },
        },
      }),
    }

    await runCli(rootDir, ["provider", "set", "--provider", "openai", "--api-key", "test-key"], env)
    await runCli(rootDir, ["model", "set", "--provider", "openai", "--model", "test-model"], env)

    const { stdout } = await runCli(rootDir, ["tables", realFixturePdf, "--page", "1", "--workspace", workspaceDir], env)
    const result = JSON.parse(stdout) as {
      tables: Array<{ latexTabular: string; caption?: string }>
      cacheStatus: string
    }

    expect(result.cacheStatus).toBe("fresh")
    expect(result.tables.length).toBeGreaterThan(0)
    expect(result.tables[0]?.latexTabular).toContain("\\begin{tabular}")
  })

  itWithNode20("extracts LaTeX formulas from a page via the formulas CLI command", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-formulas-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-formulas-"))
    const providerServer = await startSemanticCliTestProvider()
    semanticCliTestServers.push(providerServer.close)
    const env = {
      HOME: homeDir,
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: { defaultRenderScale: 2 },
        pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
        agent: { defaultProvider: "openai", defaultModel: "", tablePrompt: "unused" },
        providers: {
          openai: {
            type: "openai",
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: providerServer.baseUrl,
            endpoints: { chatCompletionsPath: "/chat/completions", modelsPath: "/models" },
          },
        },
      }),
    }

    await runCli(rootDir, ["provider", "set", "--provider", "openai", "--api-key", "test-key"], env)
    await runCli(rootDir, ["model", "set", "--provider", "openai", "--model", "test-model"], env)

    const { stdout } = await runCli(rootDir, ["formulas", realFixturePdf, "--page", "1", "--workspace", workspaceDir], env)
    const result = JSON.parse(stdout) as {
      formulas: Array<{ latexMath: string; label?: string }>
      cacheStatus: string
    }

    expect(result.cacheStatus).toBe("fresh")
    expect(result.formulas.length).toBeGreaterThan(0)
    expect(result.formulas[0]?.latexMath).toBe("E = mc^2")
  })

  itWithNode20("extracts combined page understanding via the understanding CLI command", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-understanding-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-understanding-"))
    const providerServer = await startSemanticCliTestProvider()
    semanticCliTestServers.push(providerServer.close)
    const env = {
      HOME: homeDir,
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: { defaultRenderScale: 2 },
        pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
        agent: { defaultProvider: "openai", defaultModel: "", tablePrompt: "unused" },
        providers: {
          openai: {
            type: "openai",
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: providerServer.baseUrl,
            endpoints: { chatCompletionsPath: "/chat/completions", modelsPath: "/models" },
          },
        },
      }),
    }

    await runCli(rootDir, ["provider", "set", "--provider", "openai", "--api-key", "test-key"], env)
    await runCli(rootDir, ["model", "set", "--provider", "openai", "--model", "test-model"], env)

    const { stdout } = await runCli(rootDir, ["understanding", realFixturePdf, "--page", "1", "--workspace", workspaceDir], env)
    const result = JSON.parse(stdout) as {
      tables: Array<{ latexTabular: string }>
      formulas: Array<{ latexMath: string }>
      figures: Array<{ figureType: string; description: string }>
      cacheStatus: string
    }

    expect(result.cacheStatus).toBe("fresh")
    expect(result.tables.length).toBeGreaterThan(0)
    expect(result.tables[0]?.latexTabular).toContain("\\begin{tabular}")
    expect(result.formulas.length).toBeGreaterThan(0)
    expect(result.formulas[0]?.latexMath).toBe("E = mc^2")
    expect(result.figures.length).toBeGreaterThan(0)
    expect(result.figures[0]?.figureType).toBe("diagram")
  })

  itWithNode20("fails early with a clear model error instead of silently falling back", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-no-model-"))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-no-model-"))
    const { stderr } = await runCliFailure(rootDir, ["semantic", realFixturePdf, "--workspace", workspaceDir], {
      HOME: homeDir,
      OPENAI_API_KEY: "test-key",
    })

    expect(stderr).toContain("semantic requires a configured model for provider \"openai\"")
    expect(stderr).toContain("echo-pdf model set --provider openai --model <model-id>")
  })

  itWithNode20("preserves semantic setup guidance in built CLI mode before importing the local runtime", async () => {
    const checkoutDir = await createBuiltCheckout()
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-home-built-no-model-"))
    await writeFile(
      path.join(checkoutDir, "dist", "local", "index.js"),
      'import "./missing-local-runtime.js"\n',
      "utf-8"
    )

    const { stderr } = await runCliFailure(checkoutDir, ["semantic", realFixturePdf, "--workspace", checkoutDir], {
      HOME: homeDir,
    })

    expect(stderr).toContain('semantic requires a configured model for provider "openai"')
    expect(stderr).toContain("echo-pdf model set --provider openai --model <model-id>")
    expect(stderr).not.toContain("Local primitive commands require built artifacts")
  })

  itWithNode20AndBun("supports the internal source-checkout cli:dev workflow even when dist artifacts exist", async () => {
    const checkoutDir = await createBuiltCheckout()
    await cp(path.join(rootDir, "src"), path.join(checkoutDir, "src"), { recursive: true })
    await writeFile(
      path.join(checkoutDir, "dist", "local", "index.js"),
      'throw new Error("dist local entry should not load in cli:dev");\n',
      "utf-8"
    )

    const { stdout } = await runSourceCheckoutCliDev(checkoutDir, ["document", fixturePdf, "--workspace", checkoutDir])
    const doc = JSON.parse(stdout.replace(/^>.*\n/gm, "").trim()) as {
      pageCount: number
      cacheStatus: "fresh" | "reused"
    }

    expect(doc.pageCount).toBeGreaterThan(0)
    expect(doc.cacheStatus).toBe("fresh")
  })
})
