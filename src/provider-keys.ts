import { readRequiredEnv } from "./pdf-config.js"
import type { EchoPdfConfig, EchoPdfProviderConfig } from "./pdf-types.js"
import type { Env } from "./types.js"

const normalizeKey = (value: string): string => value.trim()

const keyVariants = (value: string): string[] => {
  const raw = normalizeKey(value)
  if (raw.length === 0) return []
  return Array.from(
    new Set([
      raw,
      raw.replace(/-/g, "_"),
      raw.replace(/_/g, "-"),
    ])
  )
}

export const runtimeProviderKeyCandidates = (
  _config: EchoPdfConfig,
  providerAlias: string,
  provider: EchoPdfProviderConfig
): string[] => {
  const aliases = keyVariants(providerAlias)
  const types = keyVariants(provider.type)
  return Array.from(new Set([...aliases, ...types]))
}

export const resolveProviderApiKey = (input: {
  config: EchoPdfConfig
  env: Env
  providerAlias: string
  provider: EchoPdfProviderConfig
  runtimeApiKeys?: Record<string, string>
}): string => {
  const candidates = runtimeProviderKeyCandidates(input.config, input.providerAlias, input.provider)
  for (const candidate of candidates) {
    const value = input.runtimeApiKeys?.[candidate]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return readRequiredEnv(input.env, input.provider.apiKeyEnv)
}
