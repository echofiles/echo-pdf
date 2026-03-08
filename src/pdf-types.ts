import type { ProviderType, ReturnMode } from "./types"

export interface EchoPdfProviderConfig {
  readonly type: ProviderType
  readonly apiKeyEnv: string
  readonly baseUrl?: string
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
  readonly endpoints?: {
    readonly chatCompletionsPath?: string
    readonly modelsPath?: string
  }
}

export interface StoragePolicy {
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly ttlHours: number
  readonly cleanupBatchSize: number
}

export interface EchoPdfConfig {
  readonly service: {
    readonly name: string
    readonly maxPdfBytes: number
    readonly maxPagesPerRequest: number
    readonly defaultRenderScale: number
    readonly storage: StoragePolicy
  }
  readonly pdfium: {
    readonly wasmUrl: string
  }
  readonly agent: {
    readonly defaultProvider: string
    readonly defaultModel?: string
    readonly defaultModels?: Record<string, string>
    readonly ocrPrompt: string
    readonly tablePrompt: string
  }
  readonly providers: Record<string, EchoPdfProviderConfig>
  readonly mcp: {
    readonly serverName: string
    readonly version: string
    readonly authHeader?: string
    readonly authEnv?: string
  }
}

export interface AgentTraceEvent {
  readonly kind: "step"
  readonly phase: "start" | "end" | "log"
  readonly name: string
  readonly level?: "info" | "error"
  readonly payload?: unknown
}

export interface PdfOperationRequest {
  readonly operation: "extract_pages" | "ocr_pages" | "tables_to_latex"
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly filename?: string
  readonly pages: ReadonlyArray<number>
  readonly renderScale?: number
  readonly provider?: string
  readonly model: string
  readonly providerApiKeys?: Record<string, string>
  readonly returnMode?: ReturnMode
  readonly prompt?: string
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly source: {
    readonly kind: "local"
    readonly toolName: string
  }
}
