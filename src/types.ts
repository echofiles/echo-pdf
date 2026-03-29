export type ProviderType = "openai" | "openrouter" | "vercel-ai-gateway"

export interface Env {
  readonly ECHO_PDF_CONFIG_JSON?: string
  readonly [key: string]: string | undefined
}
