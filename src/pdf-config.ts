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
  if (!config.service?.storage) throw new Error("service.storage is required")
  if (!Number.isFinite(config.service.storage.maxFileBytes) || config.service.storage.maxFileBytes <= 0) {
    throw new Error("service.storage.maxFileBytes must be positive")
  }
  if (!Number.isFinite(config.service.storage.maxTotalBytes) || config.service.storage.maxTotalBytes <= 0) {
    throw new Error("service.storage.maxTotalBytes must be positive")
  }
  if (config.service.storage.maxTotalBytes < config.service.storage.maxFileBytes) {
    throw new Error("service.storage.maxTotalBytes must be >= maxFileBytes")
  }
  if (!Number.isFinite(config.service.storage.ttlHours) || config.service.storage.ttlHours <= 0) {
    throw new Error("service.storage.ttlHours must be positive")
  }
  if (!Number.isFinite(config.service.storage.cleanupBatchSize) || config.service.storage.cleanupBatchSize <= 0) {
    throw new Error("service.storage.cleanupBatchSize must be positive")
  }
  if (!config.agent?.defaultProvider) throw new Error("agent.defaultProvider is required")
  if (!config.providers?.[config.agent.defaultProvider]) {
    throw new Error(`default provider "${config.agent.defaultProvider}" missing`)
  }
  if (!config.agent.defaultModels || typeof config.agent.defaultModels !== "object") {
    throw new Error("agent.defaultModels is required")
  }
  return config
}

const normalizeDefaultModels = (config: EchoPdfConfig): Record<string, string> => {
  const mapped = typeof config.agent.defaultModels === "object" && config.agent.defaultModels !== null
    ? config.agent.defaultModels
    : {}
  const result: Record<string, string> = {}
  for (const alias of Object.keys(config.providers)) {
    const value = mapped[alias]
    if (typeof value === "string") result[alias] = value.trim()
    else result[alias] = ""
  }
  return result
}

const envKeyForProviderModel = (providerAlias: string): string =>
  `ECHO_PDF_MODEL_${providerAlias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

export const loadEchoPdfConfig = (env: Env): EchoPdfConfig => {
  const fromEnv = env.ECHO_PDF_CONFIG_JSON?.trim()
  const configJson = fromEnv ? JSON.parse(fromEnv) : rawConfig
  const resolved = resolveEnvRefs(configJson as unknown as JsonValue, env) as unknown as EchoPdfConfig

  const providerOverride = env.ECHO_PDF_DEFAULT_PROVIDER
  const modelOverride = env.ECHO_PDF_DEFAULT_MODEL
  const normalizedDefaultModels = normalizeDefaultModels(resolved)

  const defaultProvider =
    typeof providerOverride === "string" && providerOverride.trim().length > 0
      ? providerOverride.trim()
      : resolved.agent.defaultProvider

  for (const providerAlias of Object.keys(resolved.providers)) {
    const override = env[envKeyForProviderModel(providerAlias)]
    if (typeof override === "string" && override.trim().length > 0) {
      normalizedDefaultModels[providerAlias] = override.trim()
    }
  }
  if (typeof modelOverride === "string" && modelOverride.trim().length > 0) {
    normalizedDefaultModels[defaultProvider] = modelOverride.trim()
  }

  const withOverrides: EchoPdfConfig = {
    ...resolved,
    agent: {
      ...resolved.agent,
      defaultProvider,
      defaultModel: normalizedDefaultModels[defaultProvider] ?? "",
      defaultModels: normalizedDefaultModels,
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

  // Backward compatibility: allow *_KEY and *_API_KEY aliases.
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
