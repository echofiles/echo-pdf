import type { Env } from "./types.js"
import type { EchoPdfConfig, EchoPdfProviderConfig } from "./pdf-types.js"
import { resolveProviderApiKey } from "./provider-keys.js"

const defaultBaseUrl = (provider: EchoPdfProviderConfig): string => {
  if (provider.baseUrl) return provider.baseUrl
  switch (provider.type) {
    case "openrouter":
      return "https://openrouter.ai/api/v1"
    case "vercel-ai-gateway":
      return "https://ai-gateway.vercel.sh/v1"
    case "openai":
    default:
      return "https://api.openai.com/v1"
  }
}

const noTrailingSlash = (url: string): string => url.replace(/\/+$/, "")

const resolveEndpoint = (
  provider: EchoPdfProviderConfig,
  kind: "chatCompletionsPath" | "modelsPath"
): string => {
  const configured = provider.endpoints?.[kind]
  if (configured?.startsWith("http://") || configured?.startsWith("https://")) {
    return configured
  }
  const fallback = kind === "chatCompletionsPath" ? "/chat/completions" : "/models"
  const path = configured && configured.length > 0 ? configured : fallback
  return `${noTrailingSlash(defaultBaseUrl(provider))}${path.startsWith("/") ? path : `/${path}`}`
}

const toAuthHeader = (
  config: EchoPdfConfig,
  providerAlias: string,
  provider: EchoPdfProviderConfig,
  env: Env,
  runtimeApiKeys?: Record<string, string>
): Record<string, string> => {
  const token = resolveProviderApiKey({
    config,
    env,
    providerAlias,
    provider,
    runtimeApiKeys,
  })
  return { Authorization: `Bearer ${token}` }
}

const withTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms for ${url}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const responseDetail = async (response: Response): Promise<string> => {
  const contentType = response.headers.get("content-type") ?? ""
  try {
    if (contentType.includes("application/json")) {
      return JSON.stringify(await response.json()).slice(0, 800)
    }
    return (await response.text()).slice(0, 800)
  } catch {
    return "<unable to parse response payload>"
  }
}

const getProvider = (config: EchoPdfConfig, alias: string): EchoPdfProviderConfig => {
  const provider = config.providers[alias]
  if (!provider) {
    throw new Error(`Provider "${alias}" not configured`)
  }
  return provider
}

export const listProviderModels = async (
  config: EchoPdfConfig,
  env: Env,
  alias: string,
  runtimeApiKeys?: Record<string, string>
): Promise<ReadonlyArray<string>> => {
  const provider = getProvider(config, alias)
  const url = resolveEndpoint(provider, "modelsPath")
  const response = await withTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...toAuthHeader(config, alias, provider, env, runtimeApiKeys),
        ...(provider.headers ?? {}),
      },
    },
    provider.timeoutMs ?? 30000
  )

  if (!response.ok) {
    throw new Error(`Model list request failed: HTTP ${response.status} url=${url} detail=${await responseDetail(response)}`)
  }

  const payload = await response.json()
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((item) => item as { id?: unknown })
    .map((item) => (typeof item.id === "string" ? item.id : ""))
    .filter((id) => id.length > 0)
}

export const visionRecognize = async (input: {
  config: EchoPdfConfig
  env: Env
  providerAlias: string
  model: string
  prompt: string
  imageDataUrl: string
  runtimeApiKeys?: Record<string, string>
}): Promise<string> => {
  const provider = getProvider(input.config, input.providerAlias)
  const url = resolveEndpoint(provider, "chatCompletionsPath")
  const response = await withTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...toAuthHeader(input.config, input.providerAlias, provider, input.env, input.runtimeApiKeys),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.prompt },
              { type: "image_url", image_url: { url: input.imageDataUrl } },
            ],
          },
        ],
      }),
    },
    provider.timeoutMs ?? 30000
  )

  if (!response.ok) {
    throw new Error(`Vision request failed: HTTP ${response.status} url=${url} detail=${await responseDetail(response)}`)
  }

  const payload = await response.json()
  const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
  if (!message) return ""
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => part as { type?: string; text?: string })
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("")
  }
  return ""
}

export const generateText = async (input: {
  config: EchoPdfConfig
  env: Env
  providerAlias: string
  model: string
  prompt: string
  runtimeApiKeys?: Record<string, string>
}): Promise<string> => {
  const provider = getProvider(input.config, input.providerAlias)
  const url = resolveEndpoint(provider, "chatCompletionsPath")
  const response = await withTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...toAuthHeader(input.config, input.providerAlias, provider, input.env, input.runtimeApiKeys),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "user",
            content: input.prompt,
          },
        ],
      }),
    },
    provider.timeoutMs ?? 30000
  )

  if (!response.ok) {
    throw new Error(`Text generation request failed: HTTP ${response.status} url=${url} detail=${await responseDetail(response)}`)
  }

  const payload = await response.json()
  const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
  if (!message) return ""
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => part as { type?: string; text?: string })
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("")
  }
  return ""
}
