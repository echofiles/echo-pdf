import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { repoOwnedSamplePaths } from "../../samples/index.js"

const testServers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (testServers.length > 0) {
    const close = testServers.pop()
    if (close) await close()
  }
})

const startFlakyLocalProvider = async (): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  let tableAttempts = 0
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

    if (!prompt.includes("table")) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unexpected prompt" }))
      return
    }

    tableAttempts += 1
    if (tableAttempts === 1) {
      res.writeHead(200, { "content-type": "application/json" })
      res.flushHeaders()
      res.write('{"choices":[{"message":{"content":"')
      setTimeout(() => {
        res.socket?.destroy()
      }, 10)
      return
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            tables: [
              {
                latexTabular: "\\begin{tabular}{cc}\nAssets & Value\\\\\n\\end{tabular}",
                caption: "Recovered Table",
              },
            ],
          }),
        },
      }],
    }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("flaky provider failed to bind")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

describe("local provider stability", () => {
  it("retries one local openai-compatible 200-body read failure and still writes a real-pdf tables artifact", async () => {
    const local = await import("@echofiles/echo-pdf/local")
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-provider-stability-"))
    const providerServer = await startFlakyLocalProvider()
    testServers.push(providerServer.close)

    const config = {
      service: { defaultRenderScale: 2 },
      pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
      agent: {
        defaultProvider: "ollama",
        defaultModel: "qwen3.5-27b-vl",
        tablePrompt: "detect tables",
      },
      providers: {
        ollama: {
          type: "openai-compatible",
          apiKeyEnv: "",
          baseUrl: providerServer.baseUrl,
          endpoints: { chatCompletionsPath: "/chat/completions", modelsPath: "/models" },
          timeoutMs: 30000,
        },
      },
    } as const

    const result = await local.get_page_tables_latex({
      pdfPath: repoOwnedSamplePaths.inputPdf,
      pageNumber: 1,
      workspaceDir,
      provider: "ollama",
      model: "qwen3.5-27b-vl",
      forceRefresh: true,
      config,
    })

    expect(result.cacheStatus).toBe("fresh")
    expect(result.tables[0]?.latexTabular).toContain("\\begin{tabular}")

    const stored = JSON.parse(await readFile(result.artifactPath, "utf-8")) as { tables?: Array<{ caption?: string }> }
    expect(stored.tables?.[0]?.caption).toBe("Recovered Table")
  })
})
