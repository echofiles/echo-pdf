import rawConfig from "../echo-pdf.config.json"
import type { Env, JsonObject, JsonValue } from "./types"
import type { EchoPdfConfig } from "./pdf-types"

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const interpolateEnv = (input: string, env: Env): string =>
  input.replace(ENV_PATTERN, (_, name: string) => {
    const value = env[name]
    return typeof value === "string" ? value : `\${${name}}`
  })

const resolveEnvRefs = (value: JsonValue, env: Env): JsonValue => {
  if (typeof value === "string") return interpolateEnv(value, env)
  if (Array.isArray(value)) return value.map((item) => resolveEnvRefs(item, env))
  if (isObject(value)) {
    const out: JsonObject = {}
    for (const [key, nested] of Object.entries(value)) {
      out[key] = resolveEnvRefs(nested as JsonValue, env)
    }
    return out
  }
  return value
}

const validateConfig = (config: EchoPdfConfig): EchoPdfConfig => {
  if (!config.service?.name) throw new Error("service.name is required")
  if (!config.pdfium?.wasmUrl) throw new Error("pdfium.wasmUrl is required")
  if (!config.agent?.defaultProvider) throw new Error("agent.defaultProvider is required")
  if (!config.providers?.[config.agent.defaultProvider]) {
    throw new Error(`default provider "${config.agent.defaultProvider}" missing`)
  }
  return config
}

export const loadEchoPdfConfig = (env: Env): EchoPdfConfig => {
  const fromEnv = env.ECHO_PDF_CONFIG_JSON?.trim()
  const configJson = fromEnv ? JSON.parse(fromEnv) : rawConfig
  const resolved = resolveEnvRefs(configJson as unknown as JsonValue, env) as unknown as EchoPdfConfig
  return validateConfig(resolved)
}

export const readRequiredEnv = (env: Env, key: string): string => {
  const value = env[key]
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim()
  }
  throw new Error(`Missing required env var "${key}"`)
}
