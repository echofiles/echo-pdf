import { describe, expect, it } from "vitest"
import {
  BLOCKED_FAILURE_CODES,
  classifyThrownError,
  isBlockedFailureCode,
  resolveRunStatus,
} from "../../eval/summary-utils.mjs"

describe("eval summary utils", () => {
  it("treats operator-facing infra failures as blocked", () => {
    const blockedCodes = [
      "ENV_PROVIDER_KEY_MISSING",
      "ENV_PROVIDER_OR_MODEL_MISSING",
      "INFRA_REQUEST_TIMEOUT",
      "INFRA_PROVIDER_AUTH_FAILED",
      "INFRA_PROVIDER_RATE_LIMITED",
    ]

    expect([...BLOCKED_FAILURE_CODES]).toEqual(blockedCodes)
    expect(
      blockedCodes.map((code) =>
        resolveRunStatus("pass", [{ code, layer: "infra", message: `${code} happened` }], [])
      )
    ).toEqual(["blocked", "blocked", "blocked", "blocked", "blocked"])
    expect(blockedCodes.every((code) => isBlockedFailureCode(code))).toBe(true)
  })

  it("does not mix blocked infra failures into failed counts", () => {
    const statuses = [
      classifyThrownError(new Error("Request timeout after 30000ms for https://example.test")),
      classifyThrownError(new Error("Vision request failed: HTTP 401 url=https://example.test detail=bad key")),
      classifyThrownError(new Error("Text generation request failed: HTTP 429 url=https://example.test detail=retry")),
    ].map((failure) => resolveRunStatus("pass", [failure], []))

    expect(statuses).toEqual(["blocked", "blocked", "blocked"])
    expect(statuses.includes("failed")).toBe(false)
  })
})
