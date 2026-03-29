import { describe, expect, it } from "vitest"
import { loadEchoPdfConfig } from "../../src/pdf-config"
import type { Env } from "../../src/types"

describe("loadEchoPdfConfig", () => {
  it("loads default config", () => {
    const config = loadEchoPdfConfig({} as Env)
    expect(config.service.defaultRenderScale).toBeGreaterThan(0)
    expect(config.providers[config.agent.defaultProvider]).toBeTruthy()
  })

  it("reads config override from env", () => {
    const config = loadEchoPdfConfig({
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: {
          defaultRenderScale: 1,
        },
        pdfium: {
          wasmUrl: "https://example.com/pdfium.wasm",
        },
        agent: {
          defaultProvider: "openai",
          defaultModel: "gpt-4.1-mini",
          tablePrompt: "table",
        },
        providers: {
          openai: {
            type: "openai",
            apiKeyEnv: "OPENAI_API_KEY",
          },
        },
      }),
    } as Env)
    expect(config.service.defaultRenderScale).toBe(1)
    expect(config.agent.defaultModel).toBe("gpt-4.1-mini")
  })

  it("rejects config when defaultRenderScale is not positive", () => {
    expect(() => loadEchoPdfConfig({
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: {
          defaultRenderScale: 0,
        },
        pdfium: { wasmUrl: "https://example.com/pdfium.wasm" },
        agent: {
          defaultProvider: "openai",
          defaultModel: "gpt-4.1-mini",
          tablePrompt: "table",
        },
        providers: {
          openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
        },
      }),
    } as Env)).toThrow(/defaultRenderScale/)
  })

  it("accepts custom OpenAI-compatible provider types and empty apiKeyEnv", () => {
    const config = loadEchoPdfConfig({
      ECHO_PDF_CONFIG_JSON: JSON.stringify({
        service: {
          defaultRenderScale: 2,
        },
        pdfium: {
          wasmUrl: "https://example.com/pdfium.wasm",
        },
        agent: {
          defaultProvider: "ollama",
          defaultModel: "llava:13b",
          tablePrompt: "table",
        },
        providers: {
          ollama: {
            type: "openai-compatible",
            apiKeyEnv: "",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        },
      }),
    } as Env)

    expect(config.agent.defaultProvider).toBe("ollama")
    expect(config.providers.ollama?.type).toBe("openai-compatible")
    expect(config.providers.ollama?.apiKeyEnv).toBe("")
  })
})
