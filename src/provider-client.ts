import type { Env } from "./types.js"
import type { EchoPdfConfig, EchoPdfProviderConfig } from "./pdf-types.js"
import { resolveProviderApiKey } from "./provider-keys.js"

type ProviderOperationName = "Model list request" | "Vision request" | "Text generation request"

class ProviderRequestError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_REQUEST_SEND_FAILED"
      | "PROVIDER_REQUEST_TIMEOUT"
      | "PROVIDER_RESPONSE_BODY_READ_FAILED"
      | "PROVIDER_RESPONSE_JSON_PARSE_FAILED"
      | "PROVIDER_HTTP_ERROR",
    readonly detail: {
      operation: ProviderOperationName
      providerAlias: string
      url: string
      status?: number
      attempt: number
      maxAttempts: number
      contentType?: string
      responsePreview?: string
      causeMessage?: string
    }
  ) {
    const parts = [
      `${detail.operation} failed`,
      `code=${code}`,
      `url=${detail.url}`,
      `attempt=${detail.attempt}/${detail.maxAttempts}`,
    ]
    if (typeof detail.status === "number") parts.push(`http=${detail.status}`)
    if (detail.contentType) parts.push(`contentType=${detail.contentType}`)
    if (detail.causeMessage) parts.push(`cause=${detail.causeMessage}`)
    if (detail.responsePreview) parts.push(`preview=${JSON.stringify(detail.responsePreview)}`)
    super(parts.join(" "))
    this.name = "ProviderRequestError"
  }
}

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
  return token ? { Authorization: `Bearer ${token}` } : {}
}

const isPrivateIpv4 = (hostname: string): boolean =>
  /^10\./.test(hostname) ||
  /^127\./.test(hostname) ||
  /^192\.168\./.test(hostname) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)

const isLocalOpenAiCompatible = (provider: EchoPdfProviderConfig, url: string): boolean => {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    return (
      provider.type === "openai-compatible" &&
      (hostname === "localhost" || hostname === "::1" || isPrivateIpv4(hostname))
    )
  } catch {
    return false
  }
}

const maxAttemptsFor = (
  provider: EchoPdfProviderConfig,
  url: string,
  method: string,
  operation: ProviderOperationName
): number => {
  if (method !== "POST") return 1
  if (operation === "Model list request") return 1
  return isLocalOpenAiCompatible(provider, url) ? 2 : 1
}

const truncate = (value: string, length = 800): string => value.slice(0, length)

const withTimeout = async (
  input: {
    operation: ProviderOperationName
    providerAlias: string
    url: string
    init: RequestInit
    timeoutMs: number
    attempt: number
    maxAttempts: number
  }
): Promise<Response> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort("timeout"), input.timeoutMs)
  try {
    return await fetch(input.url, { ...input.init, signal: ctrl.signal })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderRequestError("PROVIDER_REQUEST_TIMEOUT", {
        operation: input.operation,
        providerAlias: input.providerAlias,
        url: input.url,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        causeMessage: `timeout after ${input.timeoutMs}ms`,
      })
    }
    throw new ProviderRequestError("PROVIDER_REQUEST_SEND_FAILED", {
      operation: input.operation,
      providerAlias: input.providerAlias,
      url: input.url,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      causeMessage: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
  }
}

const readResponseText = async (input: {
  response: Response
  operation: ProviderOperationName
  providerAlias: string
  url: string
  attempt: number
  maxAttempts: number
}): Promise<string> => {
  const reader = input.response.body?.getReader()
  if (!reader) {
    try {
      return await input.response.text()
    } catch (error) {
      throw new ProviderRequestError("PROVIDER_RESPONSE_BODY_READ_FAILED", {
        operation: input.operation,
        providerAlias: input.providerAlias,
        url: input.url,
        status: input.response.status,
        contentType: input.response.headers.get("content-type") ?? "",
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        causeMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      chunks.push(value)
      total += value.length
    }
  } catch (error) {
    const combined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    throw new ProviderRequestError("PROVIDER_RESPONSE_BODY_READ_FAILED", {
      operation: input.operation,
      providerAlias: input.providerAlias,
      url: input.url,
      status: input.response.status,
      contentType: input.response.headers.get("content-type") ?? "",
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      causeMessage: error instanceof Error ? error.message : String(error),
      responsePreview: truncate(new TextDecoder().decode(combined)),
    })
  }

  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(combined)
}

const parseJsonResponse = <T>(input: {
  rawText: string
  response: Response
  operation: ProviderOperationName
  providerAlias: string
  url: string
  attempt: number
  maxAttempts: number
}): T => {
  try {
    return JSON.parse(input.rawText) as T
  } catch (error) {
    throw new ProviderRequestError("PROVIDER_RESPONSE_JSON_PARSE_FAILED", {
      operation: input.operation,
      providerAlias: input.providerAlias,
      url: input.url,
      status: input.response.status,
      contentType: input.response.headers.get("content-type") ?? "",
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      causeMessage: error instanceof Error ? error.message : String(error),
      responsePreview: truncate(input.rawText),
    })
  }
}

const requestJson = async <T>(input: {
  operation: ProviderOperationName
  config: EchoPdfConfig
  env: Env
  providerAlias: string
  provider: EchoPdfProviderConfig
  url: string
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: string
}): Promise<T> => {
  const maxAttempts = maxAttemptsFor(input.provider, input.url, input.method, input.operation)
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await withTimeout({
        operation: input.operation,
        providerAlias: input.providerAlias,
        url: input.url,
        init: {
          method: input.method,
          headers: input.headers,
          ...(typeof input.body === "string" ? { body: input.body } : {}),
        },
        timeoutMs: input.provider.timeoutMs ?? 30000,
        attempt,
        maxAttempts,
      })

      const rawText = await readResponseText({
        response,
        operation: input.operation,
        providerAlias: input.providerAlias,
        url: input.url,
        attempt,
        maxAttempts,
      })

      if (!response.ok) {
        throw new ProviderRequestError("PROVIDER_HTTP_ERROR", {
          operation: input.operation,
          providerAlias: input.providerAlias,
          url: input.url,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          attempt,
          maxAttempts,
          responsePreview: truncate(rawText),
        })
      }

      return parseJsonResponse<T>({
        rawText,
        response,
        operation: input.operation,
        providerAlias: input.providerAlias,
        url: input.url,
        attempt,
        maxAttempts,
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (
        attempt < maxAttempts &&
        lastError instanceof ProviderRequestError &&
        (
          lastError.code === "PROVIDER_REQUEST_SEND_FAILED" ||
          lastError.code === "PROVIDER_RESPONSE_BODY_READ_FAILED" ||
          lastError.code === "PROVIDER_RESPONSE_JSON_PARSE_FAILED"
        )
      ) {
        continue
      }
      throw lastError
    }
  }

  throw lastError ?? new Error(`${input.operation} failed`)
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
  const payload = await requestJson<{ data?: unknown }>({
    operation: "Model list request",
    config,
    env,
    providerAlias: alias,
    provider,
    url,
    method: "GET",
    headers: {
      Accept: "application/json",
      ...toAuthHeader(config, alias, provider, env, runtimeApiKeys),
      ...(provider.headers ?? {}),
    },
  })

  const data = payload.data
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
  const payload = await requestJson<{ choices?: Array<{ message?: { content?: unknown } }> }>({
    operation: "Vision request",
    config: input.config,
    env: input.env,
    providerAlias: input.providerAlias,
    provider,
    url,
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
  })

  const message = payload.choices?.[0]?.message
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
  const payload = await requestJson<{ choices?: Array<{ message?: { content?: unknown } }> }>({
    operation: "Text generation request",
    config: input.config,
    env: input.env,
    providerAlias: input.providerAlias,
    provider,
    url,
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
  })

  const message = payload.choices?.[0]?.message
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
