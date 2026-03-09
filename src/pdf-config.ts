import rawConfig from "../echo-pdf.config.json" with { type: "json" }
import type { Env, JsonObject, JsonValue } from "./types.js"
import type { EchoPdfConfig } from "./pdf-types.js"

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
  if (
    typeof config.service.publicBaseUrl === "string" &&
    config.service.publicBaseUrl.length > 0 &&
    !/^https?:\/\//.test(config.service.publicBaseUrl)
  ) {
    throw new Error("service.publicBaseUrl must start with http:// or https://")
  }
  if (typeof config.service.fileGet?.cacheTtlSeconds === "number" && config.service.fileGet.cacheTtlSeconds < 0) {
    throw new Error("service.fileGet.cacheTtlSeconds must be >= 0")
  }
  if (!Number.isFinite(config.service.storage.maxFileBytes) || config.service.storage.maxFileBytes <= 0) {
    throw new Error("service.storage.maxFileBytes must be positive")
  }
  if (config.service.storage.maxFileBytes < config.service.maxPdfBytes) {
    throw new Error("service.storage.maxFileBytes must be >= service.maxPdfBytes")
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
  if (typeof config.agent.defaultModel !== "string") {
    throw new Error("agent.defaultModel must be a string")
  }
  return config
}

export const loadEchoPdfConfig = (env: Env): EchoPdfConfig => {
  const fromEnv = env.ECHO_PDF_CONFIG_JSON?.trim()
  const configJson = fromEnv ? JSON.parse(fromEnv) : rawConfig
  const resolved = resolveEnvRefs(configJson as unknown as JsonValue, env) as unknown as EchoPdfConfig

  const providerOverride = env.ECHO_PDF_DEFAULT_PROVIDER
  const modelOverride = env.ECHO_PDF_DEFAULT_MODEL
  const publicBaseUrlOverride = env.ECHO_PDF_PUBLIC_BASE_URL
  const computeAuthHeaderOverride = env.ECHO_PDF_COMPUTE_AUTH_HEADER
  const computeAuthEnvOverride = env.ECHO_PDF_COMPUTE_AUTH_ENV
  const fileGetAuthHeaderOverride = env.ECHO_PDF_FILE_GET_AUTH_HEADER
  const fileGetAuthEnvOverride = env.ECHO_PDF_FILE_GET_AUTH_ENV
  const fileGetCacheTtlOverride = env.ECHO_PDF_FILE_GET_CACHE_TTL_SECONDS
  const withOverrides: EchoPdfConfig = {
    ...resolved,
    service: {
      ...resolved.service,
      publicBaseUrl:
        typeof publicBaseUrlOverride === "string" && publicBaseUrlOverride.trim().length > 0
          ? publicBaseUrlOverride.trim()
          : resolved.service.publicBaseUrl,
      computeAuth: {
        authHeader:
          typeof computeAuthHeaderOverride === "string" && computeAuthHeaderOverride.trim().length > 0
            ? computeAuthHeaderOverride.trim()
            : resolved.service.computeAuth?.authHeader,
        authEnv:
          typeof computeAuthEnvOverride === "string" && computeAuthEnvOverride.trim().length > 0
            ? computeAuthEnvOverride.trim()
            : resolved.service.computeAuth?.authEnv,
      },
      fileGet: {
        authHeader:
          typeof fileGetAuthHeaderOverride === "string" && fileGetAuthHeaderOverride.trim().length > 0
            ? fileGetAuthHeaderOverride.trim()
            : resolved.service.fileGet?.authHeader,
        authEnv:
          typeof fileGetAuthEnvOverride === "string" && fileGetAuthEnvOverride.trim().length > 0
            ? fileGetAuthEnvOverride.trim()
            : resolved.service.fileGet?.authEnv,
        cacheTtlSeconds: (() => {
          if (typeof fileGetCacheTtlOverride === "string" && fileGetCacheTtlOverride.trim().length > 0) {
            const value = Number(fileGetCacheTtlOverride)
            return Number.isFinite(value) && value >= 0 ? Math.floor(value) : resolved.service.fileGet?.cacheTtlSeconds
          }
          return resolved.service.fileGet?.cacheTtlSeconds
        })(),
      },
    },
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
