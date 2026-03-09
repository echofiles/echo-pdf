import { describe, expect, it } from "vitest"
import { handleMcpRequest } from "../../src/mcp-server"
import type { EchoPdfConfig } from "../../src/pdf-types"
import type { Env, FileStore } from "../../src/types"

const configWithMcpAuth = (): EchoPdfConfig => ({
  service: {
    name: "echo-pdf-test",
    publicBaseUrl: "http://127.0.0.1:8788",
    maxPdfBytes: 1_000_000,
    maxPagesPerRequest: 20,
    defaultRenderScale: 2,
    storage: {
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
      ttlHours: 24,
      cleanupBatchSize: 50,
    },
  },
  pdfium: {
    wasmUrl: "https://example.com/pdfium.wasm",
  },
  agent: {
    defaultProvider: "openai",
    defaultModel: "",
    ocrPrompt: "ocr",
    tablePrompt: "table",
  },
  providers: {
    openai: {
      type: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  },
  mcp: {
    serverName: "echo-pdf-mcp",
    version: "0.1.0",
    authHeader: "x-mcp-key",
    authEnv: "ECHO_PDF_MCP_KEY",
  },
})

const noopFileStore: FileStore = {
  async put(input) {
    return {
      id: "test-id",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      createdAt: new Date().toISOString(),
    }
  },
  async get() {
    return null
  },
  async list() {
    return []
  },
  async delete() {
    return false
  },
}

describe("handleMcpRequest auth envelope", () => {
  it("returns JSON-RPC envelope for unauthorized requests", async () => {
    const request = new Request("http://127.0.0.1:8788/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    const env = { ECHO_PDF_MCP_KEY: "secret" } as Env

    const response = await handleMcpRequest(request, env, configWithMcpAuth(), noopFileStore)
    const payload = (await response.json()) as {
      jsonrpc?: string
      id?: unknown
      error?: { code?: number; message?: string; data?: { status?: number; code?: string } }
    }

    expect(response.status).toBe(200)
    expect(payload.jsonrpc).toBe("2.0")
    expect(payload.id).toBeNull()
    expect(payload.error?.code).toBe(-32001)
    expect(payload.error?.data?.status).toBe(401)
    expect(payload.error?.data?.code).toBe("UNAUTHORIZED")
  })
})
