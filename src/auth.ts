import type { Env } from "./types.js"

export interface AuthCheckOptions {
  readonly authHeader?: string
  readonly authEnv?: string
  readonly allowMissingSecret?: boolean
  readonly misconfiguredCode: string
  readonly unauthorizedCode: string
  readonly contextName: string
}

export type AuthCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

export const checkHeaderAuth = (
  request: Request,
  env: Env,
  options: AuthCheckOptions
): AuthCheckResult => {
  const authHeader = typeof options.authHeader === "string" ? options.authHeader.trim() : ""
  const authEnv = typeof options.authEnv === "string" ? options.authEnv.trim() : ""
  const hasHeader = authHeader.length > 0
  const hasEnv = authEnv.length > 0
  if (!hasHeader && !hasEnv) return { ok: true }
  if (!hasHeader || !hasEnv) {
    return {
      ok: false,
      status: 500,
      code: options.misconfiguredCode,
      message: `${options.contextName} auth must configure both authHeader and authEnv`,
    }
  }

  const required = env[authEnv]
  if (typeof required !== "string" || required.length === 0) {
    if (options.allowMissingSecret === true) return { ok: true }
    return {
      ok: false,
      status: 500,
      code: options.misconfiguredCode,
      message: `${options.contextName} auth is configured but env "${authEnv}" is missing`,
    }
  }
  if (request.headers.get(authHeader) !== required) {
    return {
      ok: false,
      status: 401,
      code: options.unauthorizedCode,
      message: "Unauthorized",
    }
  }
  return { ok: true }
}
