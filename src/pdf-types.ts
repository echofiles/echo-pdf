import type { ProviderType } from "./types.js"

export interface EchoPdfProviderConfig {
  readonly type: ProviderType
  readonly apiKeyEnv?: string
  readonly baseUrl?: string
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
  readonly endpoints?: {
    readonly chatCompletionsPath?: string
    readonly modelsPath?: string
  }
}

export interface EchoPdfConfig {
  readonly service: {
    readonly defaultRenderScale: number
  }
  readonly pdfium: {
    readonly wasmUrl: string
  }
  readonly agent: {
    readonly defaultProvider: string
    readonly defaultModel: string
    readonly tablePrompt: string
    readonly formulaPrompt?: string
  }
  readonly providers: Record<string, EchoPdfProviderConfig>
}
