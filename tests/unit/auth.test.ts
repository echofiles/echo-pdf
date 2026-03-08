import { describe, expect, it } from "vitest"
import { checkHeaderAuth } from "../../src/auth"
import type { Env } from "../../src/types"

const requestWith = (header: string, value?: string): Request =>
  new Request("https://example.com/test", {
    headers: typeof value === "string" ? { [header]: value } : {},
  })

describe("checkHeaderAuth", () => {
  it("denies when auth is configured but secret is missing", () => {
    const result = checkHeaderAuth(
      requestWith("x-test", "abc"),
      {} as Env,
      {
        authHeader: "x-test",
        authEnv: "TEST_SECRET",
        misconfiguredCode: "AUTH_MISCONFIGURED",
        unauthorizedCode: "UNAUTHORIZED",
        contextName: "mcp",
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(500)
      expect(result.code).toBe("AUTH_MISCONFIGURED")
    }
  })

  it("denies when secret exists but header is missing or wrong", () => {
    const env = { TEST_SECRET: "abc" } as Env
    const missing = checkHeaderAuth(
      requestWith("x-test"),
      env,
      {
        authHeader: "x-test",
        authEnv: "TEST_SECRET",
        misconfiguredCode: "AUTH_MISCONFIGURED",
        unauthorizedCode: "UNAUTHORIZED",
        contextName: "mcp",
      }
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.status).toBe(401)
      expect(missing.code).toBe("UNAUTHORIZED")
    }

    const wrong = checkHeaderAuth(
      requestWith("x-test", "wrong"),
      env,
      {
        authHeader: "x-test",
        authEnv: "TEST_SECRET",
        misconfiguredCode: "AUTH_MISCONFIGURED",
        unauthorizedCode: "UNAUTHORIZED",
        contextName: "mcp",
      }
    )
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.status).toBe(401)
  })

  it("allows with correct secret header", () => {
    const result = checkHeaderAuth(
      requestWith("x-test", "abc"),
      { TEST_SECRET: "abc" } as Env,
      {
        authHeader: "x-test",
        authEnv: "TEST_SECRET",
        misconfiguredCode: "AUTH_MISCONFIGURED",
        unauthorizedCode: "UNAUTHORIZED",
        contextName: "mcp",
      }
    )
    expect(result).toEqual({ ok: true })
  })
})
