import type { EchoPdfConfig } from "./pdf-types"

const normalize = (value: string): string => value.trim()

export const resolveProviderAlias = (
  config: EchoPdfConfig,
  requestedProvider?: string
): string => {
  const raw = normalize(requestedProvider ?? "")
  if (raw.length === 0) return config.agent.defaultProvider
  if (config.providers[raw]) return raw
  const fromType = Object.entries(config.providers).find(([, provider]) => provider.type === raw)?.[0]
  if (fromType) return fromType
  throw new Error(`Provider "${raw}" not configured`)
}

export const resolveModelForProvider = (
  config: EchoPdfConfig,
  providerAlias: string,
  requestedModel?: string
): string => {
  const explicit = normalize(requestedModel ?? "")
  if (explicit.length > 0) return explicit
  const fromMap = normalize(config.agent.defaultModels?.[providerAlias] ?? "")
  if (fromMap.length > 0) return fromMap
  return normalize(config.agent.defaultModel ?? "")
}
