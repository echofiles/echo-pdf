export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonArray = JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export type ProviderType = "openai" | "openrouter" | "vercel-ai-gateway"
export type ReturnMode = "inline" | "file_id" | "url"

export interface Env {
  readonly ECHO_PDF_CONFIG_JSON?: string
  readonly ASSETS?: Fetcher
  readonly [key: string]: string | Fetcher | undefined
}

export interface StoredFileMeta {
  readonly id: string
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly createdAt: string
}

export interface StoredFileRecord extends StoredFileMeta {
  readonly bytes: Uint8Array
}

export interface FileStore {
  put(input: {
    readonly filename: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<StoredFileMeta>
  get(fileId: string): Promise<StoredFileRecord | null>
  list(): Promise<ReadonlyArray<StoredFileMeta>>
  delete(fileId: string): Promise<boolean>
}
