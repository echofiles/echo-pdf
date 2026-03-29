export const BLOCKED_FAILURE_CODES = new Set([
  "ENV_PROVIDER_KEY_MISSING",
  "ENV_PROVIDER_OR_MODEL_MISSING",
  "INFRA_REQUEST_TIMEOUT",
  "INFRA_PROVIDER_AUTH_FAILED",
  "INFRA_PROVIDER_RATE_LIMITED",
])

export const isBlockedFailureCode = (code) =>
  typeof code === "string" && BLOCKED_FAILURE_CODES.has(code)

export const hasBlockedFailure = (failures) =>
  Array.isArray(failures) && failures.some((failure) => isBlockedFailureCode(failure?.code))

export const classifyThrownError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/Missing required env var/i.test(message)) {
    return { code: "ENV_PROVIDER_KEY_MISSING", layer: "infra", message }
  }
  if (/model is required/i.test(message) || /Provider ".+" not configured/i.test(message)) {
    return { code: "ENV_PROVIDER_OR_MODEL_MISSING", layer: "infra", message }
  }
  if (/timeout/i.test(message)) {
    return { code: "INFRA_REQUEST_TIMEOUT", layer: "infra", message }
  }
  if (/HTTP 401|HTTP 403/i.test(message)) {
    return { code: "INFRA_PROVIDER_AUTH_FAILED", layer: "infra", message }
  }
  if (/HTTP 429/i.test(message)) {
    return { code: "INFRA_PROVIDER_RATE_LIMITED", layer: "infra", message }
  }
  if (/not valid JSON/i.test(message)) {
    return { code: "SEMANTIC_MODEL_OUTPUT_INVALID", layer: "semantic", message }
  }
  if (/Failed to load PDF|pageNumber must be within/i.test(message)) {
    return { code: "INPUT_PDF_INVALID", layer: "sample", message }
  }
  return { code: "RUNNER_UNCLASSIFIED_ERROR", layer: "runner", message }
}

export const finalizeStatus = (expectedOutcome, failures, expectedFailureCodes) => {
  if (failures.length === 0) {
    return expectedOutcome === "known-bad" ? "unexpected-pass" : "passed"
  }
  if (expectedOutcome === "known-bad") {
    const expectedCodes = new Set(Array.isArray(expectedFailureCodes) ? expectedFailureCodes : [])
    const onlyExpected = expectedCodes.size === 0 || failures.every((failure) => expectedCodes.has(failure.code))
    return onlyExpected ? "known-bad" : "failed"
  }
  return "failed"
}

export const resolveRunStatus = (expectedOutcome, failures, expectedFailureCodes) => {
  if (hasBlockedFailure(failures)) return "blocked"
  return finalizeStatus(expectedOutcome, failures, expectedFailureCodes)
}
