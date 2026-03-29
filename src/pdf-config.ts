import rawConfig from "../echo-pdf.config.json" with { type: "json" }
import type { Env } from "./types.js"
import type { EchoPdfConfig } from "./pdf-types.js"

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const interpolateEnv = (input: string, env: Env): string =>
  input.replace(ENV_PATTERN, (_, name: string) => {
    const value = env[name]
    return typeof value === "string" ? value : `\${${name}}`
  })

const resolveEnvRefs = (value: unknown, env: Env): unknown => {
  if (typeof value === "string") return interpolateEnv(value, env)
  if (Array.isArray(value)) return value.map((item) => resolveEnvRefs(item, env))
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      out[key] = resolveEnvRefs(nested, env)
    }
    return out
  }
  return value
}

const validateConfig = (config: EchoPdfConfig): EchoPdfConfig => {
  if (!config.pdfium?.wasmUrl) throw new Error("pdfium.wasmUrl is required")
  if (!Number.isFinite(config.service?.defaultRenderScale) || config.service.defaultRenderScale <= 0) {
    throw new Error("service.defaultRenderScale must be positive")
  }
  if (!config.agent?.defaultProvider) throw new Error("agent.defaultProvider is required")
  if (!config.providers?.[config.agent.defaultProvider]) {
    throw new Error(`default provider "${config.agent.defaultProvider}" missing`)
  }
  if (typeof config.agent.defaultModel !== "string") {
    throw new Error("agent.defaultModel must be a string")
  }
  return config
}

export const loadEchoPdfConfig = (env: Env): EchoPdfConfig => {
  const fromEnv = env.ECHO_PDF_CONFIG_JSON?.trim()
  const configJson = fromEnv ? JSON.parse(fromEnv) : rawConfig
  const resolved = resolveEnvRefs(configJson, env) as EchoPdfConfig

  const providerOverride = env.ECHO_PDF_DEFAULT_PROVIDER
  const modelOverride = env.ECHO_PDF_DEFAULT_MODEL
  const withOverrides: EchoPdfConfig = {
    ...resolved,
    agent: {
      ...resolved.agent,
      defaultProvider:
        typeof providerOverride === "string" && providerOverride.trim().length > 0
          ? providerOverride.trim()
          : resolved.agent.defaultProvider,
      defaultModel:
        typeof modelOverride === "string" && modelOverride.trim().length > 0
          ? modelOverride.trim()
          : resolved.agent.defaultModel,
    },
  }

  return validateConfig(withOverrides)
}

export const readRequiredEnv = (env: Env, key: string): string => {
  const read = (name: string): string | null => {
    const value = env[name]
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
  }
  const direct = read(key)
  if (direct) return direct
  if (key.endsWith("_API_KEY")) {
    const alt = read(key.replace(/_API_KEY$/, "_KEY"))
    if (alt) return alt
  }
  if (key.endsWith("_KEY")) {
    const alt = read(key.replace(/_KEY$/, "_API_KEY"))
    if (alt) return alt
  }
  throw new Error(`Missing required env var "${key}"`)
}
