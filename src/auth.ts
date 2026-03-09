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
  if (!options.authHeader || !options.authEnv) return { ok: true }
  const required = env[options.authEnv]
  if (typeof required !== "string" || required.length === 0) {
    if (options.allowMissingSecret === true) return { ok: true }
    return {
      ok: false,
      status: 500,
      code: options.misconfiguredCode,
      message: `${options.contextName} auth is configured but env "${options.authEnv}" is missing`,
    }
  }
  if (request.headers.get(options.authHeader) !== required) {
    return {
      ok: false,
      status: 401,
      code: options.unauthorizedCode,
      message: "Unauthorized",
    }
  }
  return { ok: true }
}
