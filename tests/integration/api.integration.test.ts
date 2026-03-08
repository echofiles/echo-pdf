import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import configJson from "../../echo-pdf.config.json"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const bundledFixtureDir = path.join(rootDir, "fixtures")
const defaultFixturePdf = path.join(bundledFixtureDir, "smoke.pdf")
const testcaseDir = process.env.TESTCASE_DIR ?? path.resolve(rootDir, "..", "testcase/eda")
const port = process.env.PORT ?? "8788"
const baseUrl = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${port}`
const logPath = path.join(rootDir, ".integration-dev.log")

let devProcess: ChildProcess | null = null
let devLogs = ""
let fixturePdf = defaultFixturePdf
let fallbackFixturePdf = defaultFixturePdf
let maxFileBytes = 0

const providerEntries = Object.entries(configJson.providers ?? {})

const envCandidates = (key: string): string[] => {
  const candidates = [key]
  if (key.endsWith("_API_KEY")) candidates.push(key.replace(/_API_KEY$/, "_KEY"))
  if (key.endsWith("_KEY")) candidates.push(key.replace(/_KEY$/, "_API_KEY"))
  return Array.from(new Set(candidates))
}

const readFirstEnv = (keys: string[]): string => {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return ""
}

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

const detectLlmProvider = (): string | null => {
  const forced = process.env.SMOKE_LLM_PROVIDER
  if (typeof forced === "string" && forced.trim().length > 0) {
    const normalized = forced.trim()
    if (configJson.providers?.[normalized]) return normalized
  }
  for (const [providerAlias, providerConfig] of providerEntries) {
    if (readFirstEnv(envCandidates(providerConfig.apiKeyEnv)).length > 0) {
      return providerAlias
    }
  }
  return null
}

const providerApiKeys = (): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [providerAlias, providerConfig] of providerEntries) {
    const key = readFirstEnv(envCandidates(providerConfig.apiKeyEnv))
    result[providerAlias] = key
    result[providerConfig.type] = key
  }
  return result
}

const resolveLlmModel = (): string => {
  const fromSmoke = process.env.SMOKE_LLM_MODEL?.trim()
  if (fromSmoke) return fromSmoke
  const fromEnv = process.env.ECHO_PDF_DEFAULT_MODEL?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = configJson.agent?.defaultModel?.trim()
  return fromConfig || ""
}

const resolveFixturePdf = async (): Promise<string> => {
  try {
    const dirStat = await stat(testcaseDir)
    if (dirStat.isDirectory()) {
      const files = await readdir(testcaseDir)
      const candidate = files.find((file) => file.toLowerCase().endsWith(".pdf"))
      if (candidate) {
        return path.join(testcaseDir, candidate)
      }
    }
  } catch {
    // ignore
  }
  return defaultFixturePdf
}

const resolveBundledFixturePdf = async (): Promise<string> => {
  try {
    const files = await readdir(bundledFixtureDir)
    const candidate = files
      .filter((file) => file.toLowerCase().endsWith(".pdf"))
      .sort((a, b) => a.localeCompare(b))[0]
    if (candidate) return path.join(bundledFixtureDir, candidate)
  } catch {
    // ignore
  }
  return defaultFixturePdf
}

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

const uploadPdf = async (candidatePath: string): Promise<{ fileId: string }> => {
  const bytes = await readFile(candidatePath)
  const form = new FormData()
  form.set("file", new Blob([bytes], { type: "application/pdf" }), path.basename(candidatePath))
  const response = await fetch(`${baseUrl}/api/files/upload`, {
    method: "POST",
    body: form,
  })
  const data = (await response.json()) as { file?: { id?: string }; error?: string }
  if (!response.ok || !data.file?.id) {
    throw new Error(data.error || `upload failed (${response.status}) for ${candidatePath}`)
  }
  return { fileId: data.file.id }
}

describe("echo-pdf integration", () => {
  beforeAll(async () => {
    await readEnvLocal()
    fallbackFixturePdf = await resolveBundledFixturePdf()
    fixturePdf = await resolveFixturePdf()

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
    const config = (await fetch(`${baseUrl}/config`).then((r) => r.json())) as {
      service?: { storage?: { maxFileBytes?: number } }
    }
    maxFileBytes = Number(config.service?.storage?.maxFileBytes ?? 0)
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
    let uploadPath = fixturePdf
    if (maxFileBytes > 0) {
      const s = await stat(uploadPath)
      if (s.size > maxFileBytes) {
        uploadPath = fallbackFixturePdf
      }
    }
    const primary = await uploadPdf(uploadPath)
    const fileId = primary.fileId
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

  it("returns 400 for invalid agent operation", async () => {
    const response = await fetch(`${baseUrl}/api/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "invalid_op", pages: [1] }),
    })
    const payload = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(typeof payload.error).toBe("string")
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

  it("returns json-rpc parse error for invalid mcp payload", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    })
    const payload = await response.json() as { error?: { code?: number } }
    expect(response.status).toBe(400)
    expect(payload.error?.code).toBe(-32700)
  })

  it("runs real provider model list + ocr + tables when key is configured", async () => {
    const provider = detectLlmProvider()
    if (!provider) {
      return
    }
    const model = resolveLlmModel()
    if (!model) {
      if (process.env.SMOKE_REQUIRE_LLM === "1") {
        throw new Error("Missing model for LLM integration test. Set SMOKE_LLM_MODEL or ECHO_PDF_DEFAULT_MODEL.")
      }
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
    const models = modelsData.models ?? []
    expect(models.includes(model)).toBe(true)

    let uploadPath = fixturePdf
    if (maxFileBytes > 0) {
      const s = await stat(uploadPath)
      if (s.size > maxFileBytes) {
        uploadPath = fallbackFixturePdf
      }
    }
    const uploaded = await uploadPdf(uploadPath)
    const fileId = uploaded.fileId
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
    const ocrOutput = ocrData.output ?? null

    expect(Array.isArray(ocrOutput.pages)).toBe(true)
    expect(typeof ocrOutput.pages?.[0]?.text).toBe("string")
    expect(ocrOutput.pages?.[0]?.text?.trim().length).toBeGreaterThan(0)

    const tableData = await postJson("/tools/call", {
      name: "pdf_tables_to_latex",
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
        pages?: Array<{ latex?: string }>
      }
    }
    const tableOutput = tableData.output ?? null
    expect(Array.isArray(tableOutput.pages)).toBe(true)
    expect(typeof tableOutput.pages?.[0]?.latex).toBe("string")
    expect(tableOutput.pages?.[0]?.latex?.includes("\\begin{tabular}")).toBe(true)

    await postJson("/api/files/op", { op: "delete", fileId })
  })
})
