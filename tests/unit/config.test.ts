import { describe, expect, it } from "vitest"
import { loadEchoPdfConfig } from "../../src/pdf-config"
import type { Env } from "../../src/types"

describe("loadEchoPdfConfig", () => {
  it("loads default config", () => {
    const config = loadEchoPdfConfig({} as Env)
    expect(config.service.name.length).toBeGreaterThan(0)
    expect(config.providers[config.agent.defaultProvider]).toBeTruthy()
  })

  it("reads config override from env", () => {
    const config = loadEchoPdfConfig({
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: {
          name: "echo-pdf-test",
          maxPdfBytes: 1024 * 1024,
          maxPagesPerRequest: 3,
          defaultRenderScale: 1,
          storage: {
            maxFileBytes: 1024,
            maxTotalBytes: 1024 * 4,
            ttlHours: 1,
            cleanupBatchSize: 10,
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
        },
      }),
    } as Env)
    expect(config.service.name).toBe("echo-pdf-test")
  })
})
