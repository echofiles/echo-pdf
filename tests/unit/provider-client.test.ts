import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { generateText } from "../../src/provider-client.js"
import type { EchoPdfConfig } from "../../src/pdf-types.js"

const testServers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (testServers.length > 0) {
    const close = testServers.pop()
    if (close) await close()
  }
})

const makeConfig = (baseUrl: string): EchoPdfConfig => ({
  service: { defaultRenderScale: 2 },
  pdfium: { wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.7.0/dist/pdfium.wasm" },
  agent: { defaultProvider: "local_test", defaultModel: "test-model", tablePrompt: "table" },
  providers: {
    local_test: {
      type: "openai-compatible",
      apiKeyEnv: "",
      baseUrl,
      endpoints: { chatCompletionsPath: "/chat/completions", modelsPath: "/models" },
      timeoutMs: 2000,
    },
  },
})

const startServer = async (
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void> | void
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = createServer(async (req, res) => {
    await handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server failed to bind")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

describe("provider-client", () => {
  it("classifies provider non-2xx failures", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "upstream bad gateway" }))
    })
    testServers.push(server.close)

    await expect(generateText({
      config: makeConfig(server.baseUrl),
      env: process.env,
      providerAlias: "local_test",
      model: "test-model",
      prompt: "hello",
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      code: "PROVIDER_HTTP_ERROR",
    })
  })

  it("retries one local send failure before succeeding", async () => {
    let attempts = 0
    const server = await startServer((_req, res) => {
      attempts += 1
      if (attempts === 1) {
        res.socket?.destroy()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
    })
    testServers.push(server.close)

    await expect(generateText({
      config: makeConfig(server.baseUrl),
      env: process.env,
      providerAlias: "local_test",
      model: "test-model",
      prompt: "hello",
    })).resolves.toBe("ok")
    expect(attempts).toBe(2)
  })

  it("classifies unrecoverable 200-body read failures", async () => {
    let attempts = 0
    const server = await startServer((_req, res) => {
      attempts += 1
      res.writeHead(200, { "content-type": "application/json" })
      res.flushHeaders()
      res.write('{"choices":[{"message":{"content":"')
      setTimeout(() => {
        res.socket?.destroy()
      }, 10)
    })
    testServers.push(server.close)

    await expect(generateText({
      config: makeConfig(server.baseUrl),
      env: process.env,
      providerAlias: "local_test",
      model: "test-model",
      prompt: "hello",
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      code: "PROVIDER_RESPONSE_BODY_READ_FAILED",
    })
    expect(attempts).toBe(2)
  })

  it("classifies unrecoverable 200-json parse failures", async () => {
    let attempts = 0
    const server = await startServer((_req, res) => {
      attempts += 1
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"choices":[{"message":{"content":"oops"}}')
    })
    testServers.push(server.close)

    await expect(generateText({
      config: makeConfig(server.baseUrl),
      env: process.env,
      providerAlias: "local_test",
      model: "test-model",
      prompt: "hello",
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      code: "PROVIDER_RESPONSE_JSON_PARSE_FAILED",
    })
    expect(attempts).toBe(2)
  })
})
