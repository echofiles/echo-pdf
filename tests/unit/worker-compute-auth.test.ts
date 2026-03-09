import { describe, expect, it } from "vitest"
import worker from "../../src/worker"
import configJson from "../../echo-pdf.config.json"
import type { Env, WorkerExecutionContext } from "../../src/types"

const ctx: WorkerExecutionContext = {
  waitUntil() {
    // no-op for unit tests
  },
}

const buildEnv = (config: unknown, extra: Record<string, string> = {}): Env => ({
  ECHO_PDF_CONFIG_JSON: JSON.stringify(config),
  ...extra,
})

describe("worker compute auth gate", () => {
  it("keeps behavior unchanged when compute auth is not configured", async () => {
    const response = await worker.fetch(new Request("http://127.0.0.1:8788/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }), buildEnv(configJson), ctx)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toContain("Missing required field: name")
  })

  it("rejects compute endpoint requests without configured auth header", async () => {
    const response = await worker.fetch(new Request("http://127.0.0.1:8788/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "file_ops", arguments: { op: "list" } }),
    }), buildEnv({
      ...configJson,
      service: {
        ...configJson.service,
        computeAuth: {
          authHeader: "x-compute-key",
          authEnv: "ECHO_PDF_COMPUTE_KEY",
        },
      },
    }, { ECHO_PDF_COMPUTE_KEY: "secret-123" }), ctx)
    expect(response.status).toBe(401)
    const payload = (await response.json()) as { code?: string }
    expect(payload.code).toBe("UNAUTHORIZED")
  })

  it("fails closed when compute auth is configured but secret env is missing", async () => {
    const response = await worker.fetch(new Request("http://127.0.0.1:8788/providers/models", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-compute-key": "whatever" },
      body: JSON.stringify({ provider: "openai" }),
    }), buildEnv({
      ...configJson,
      service: {
        ...configJson.service,
        computeAuth: {
          authHeader: "x-compute-key",
          authEnv: "ECHO_PDF_COMPUTE_KEY",
        },
      },
    }), ctx)
    expect(response.status).toBe(500)
    const payload = (await response.json()) as { code?: string }
    expect(payload.code).toBe("COMPUTE_AUTH_MISCONFIGURED")
  })
  it("fails closed when compute auth is only partially configured", async () => {
    const response = await worker.fetch(new Request("http://127.0.0.1:8788/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "extract_pages", pages: [1] }),
    }), buildEnv({
      ...configJson,
      service: {
        ...configJson.service,
        computeAuth: {
          authHeader: "x-compute-key",
        },
      },
    }), ctx)
    expect(response.status).toBe(500)
    const payload = (await response.json()) as { code?: string }
    expect(payload.code).toBe("COMPUTE_AUTH_MISCONFIGURED")
  })
})
