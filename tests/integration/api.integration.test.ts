import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = path.join(rootDir, "scripts/fixtures/smoke.pdf")
const port = process.env.PORT ?? "8788"
const baseUrl = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${port}`
const logPath = path.join(rootDir, ".integration-dev.log")

let devProcess: ChildProcess | null = null
let devLogs = ""

const readEnvLocal = async (): Promise<void> => {
  const envPath = path.resolve(rootDir, "..", ".env.local")
  try {
    const raw = await readFile(envPath, "utf-8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  } catch {
    // .env.local is optional for integration tests
  }
}

const postJson = async (pathname: string, payload: unknown): Promise<unknown> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`invalid json from ${pathname}: ${text.slice(0, 500)}`)
  }
  if (!response.ok) {
    throw new Error(`${pathname} failed: ${response.status} ${JSON.stringify(data)}`)
  }
  return data
}

const detectLlmProvider = (): "openrouter" | "openai" | "vercel_gateway" | null => {
  if (process.env.OPENROUTER_KEY) return "openrouter"
  if (process.env.OPENAI_API_KEY) return "openai"
  if (process.env.VERCEL_AI_GATEWAY_KEY) return "vercel_gateway"
  return null
}

const providerApiKeys = (): Record<string, string> => ({
  openai: process.env.OPENAI_API_KEY ?? "",
  openrouter: process.env.OPENROUTER_KEY ?? "",
  "vercel-ai-gateway": process.env.VERCEL_AI_GATEWAY_KEY ?? "",
})

const waitForReady = async (): Promise<void> => {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`integration server not ready: ${baseUrl}\n${devLogs.slice(-2000)}`)
}

describe("echo-pdf integration", () => {
  beforeAll(async () => {
    await readEnvLocal()

    const requireLlm = process.env.SMOKE_REQUIRE_LLM === "1"
    if (requireLlm && !detectLlmProvider()) {
      throw new Error("SMOKE_REQUIRE_LLM=1 but no provider key found")
    }

    if (!process.env.SMOKE_BASE_URL) {
      devProcess = spawn("npm", ["run", "dev", "--", "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0"], {
        cwd: rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      devProcess.stdout?.on("data", (chunk: Buffer) => {
        devLogs += chunk.toString()
      })
      devProcess.stderr?.on("data", (chunk: Buffer) => {
        devLogs += chunk.toString()
      })
    }

    await waitForReady()
  })

  afterAll(async () => {
    if (devProcess) {
      devProcess.kill("SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (!devProcess.killed) devProcess.kill("SIGKILL")
    }
    if (devLogs.length > 0) {
      await writeFile(logPath, devLogs, "utf-8")
    }
  })

  it("exposes core endpoints", async () => {
    const health = (await fetch(`${baseUrl}/health`).then((r) => r.json())) as { ok?: boolean }
    expect(health.ok).toBe(true)

    const config = (await fetch(`${baseUrl}/config`).then((r) => r.json())) as {
      providers?: unknown[]
      agent?: { defaultProvider?: string }
    }
    expect(Array.isArray(config.providers)).toBe(true)
    expect(typeof config.agent?.defaultProvider).toBe("string")

    const catalog = (await fetch(`${baseUrl}/tools/catalog`).then((r) => r.json())) as {
      tools?: Array<{ name?: string }>
    }
    expect(catalog.tools?.map((t) => t.name)).toContain("pdf_extract_pages")
    expect(catalog.tools?.map((t) => t.name)).toContain("pdf_ocr_pages")
    expect(catalog.tools?.map((t) => t.name)).toContain("pdf_tables_to_latex")
    expect(catalog.tools?.map((t) => t.name)).toContain("file_ops")
  })

  it("uploads pdf and extracts inline image", async () => {
    const bytes = await readFile(fixturePdf)
    const form = new FormData()
    form.set("file", new Blob([bytes], { type: "application/pdf" }), "smoke.pdf")
    const uploadResponse = await fetch(`${baseUrl}/api/files/upload`, {
      method: "POST",
      body: form,
    })
    const uploadData = (await uploadResponse.json()) as { file?: { id?: string } }
    expect(uploadResponse.ok).toBe(true)
    const fileId = uploadData.file?.id
    expect(fileId).toBeTruthy()

    const extractData = await postJson("/tools/call", {
      name: "pdf_extract_pages",
      arguments: { fileId, pages: [1], returnMode: "inline" },
    }) as {
      output?: { images?: Array<{ data?: string }> }
    }
    expect(Array.isArray(extractData.output?.images)).toBe(true)
    expect(extractData.output?.images?.[0]?.data?.startsWith("data:image/png;base64,")).toBe(true)

    const streamResponse = await fetch(`${baseUrl}/api/agent/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "extract_pages", fileId, pages: [1], returnMode: "inline" }),
    })
    const streamText = await streamResponse.text()
    expect(streamResponse.ok).toBe(true)
    expect(streamText).toContain("event: result")
    expect(streamText).toContain("event: done")
    expect(streamText).toContain("\"ok\":true")

    await postJson("/api/files/op", { op: "delete", fileId })
  })

  it("supports mcp initialize/list/call", async () => {
    const initData = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) as {
      result?: { serverInfo?: { name?: string } }
    }
    expect(typeof initData.result?.serverInfo?.name).toBe("string")

    const toolsData = await postJson("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) as {
      result?: { tools?: Array<{ name?: string }> }
    }
    expect(toolsData.result?.tools?.map((tool) => tool.name)).toContain("file_ops")

    const callData = await postJson("/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "file_ops", arguments: { op: "list" } },
    }) as {
      result?: { content?: unknown[] }
    }
    expect(Array.isArray(callData.result?.content)).toBe(true)
  })

  it("runs real provider model list + ocr when key is configured", async () => {
    const provider = detectLlmProvider()
    if (!provider) {
      return
    }

    const modelsData = await postJson("/providers/models", {
      provider,
      providerApiKeys: providerApiKeys(),
    }) as {
      models?: string[]
    }
    expect(Array.isArray(modelsData.models)).toBe(true)
    expect((modelsData.models?.length ?? 0) > 0).toBe(true)
    const model = modelsData.models?.[0]
    expect(typeof model).toBe("string")

    const bytes = await readFile(fixturePdf)
    const form = new FormData()
    form.set("file", new Blob([bytes], { type: "application/pdf" }), "smoke.pdf")
    const uploadResponse = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", body: form })
    const uploadData = (await uploadResponse.json()) as { file?: { id?: string } }
    const fileId = uploadData.file?.id
    expect(fileId).toBeTruthy()

    const ocrData = await postJson("/tools/call", {
      name: "pdf_ocr_pages",
      arguments: {
        fileId,
        pages: [1],
        provider,
        model,
      },
      provider,
      model,
      providerApiKeys: providerApiKeys(),
    }) as {
      output?: {
        pages?: Array<{ text?: string }>
      }
    }
    expect(Array.isArray(ocrData.output?.pages)).toBe(true)
    expect(typeof ocrData.output?.pages?.[0]?.text).toBe("string")

    await postJson("/api/files/op", { op: "delete", fileId })
  })
})
