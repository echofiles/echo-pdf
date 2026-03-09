export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonArray = JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export type ProviderType = "openai" | "openrouter" | "vercel-ai-gateway"
export type ReturnMode = "inline" | "file_id" | "url"

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface DurableObjectId {}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>
  delete(key: string): Promise<boolean>
}

export interface DurableObjectState {
  storage: DurableObjectStorage
}

export interface R2ObjectBody {
  key: string
  size: number
  uploaded: Date
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    }
  ): Promise<unknown>
  get(key: string): Promise<R2ObjectBody | null>
  delete(key: string | string[]): Promise<void>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: R2ObjectBody[]
    truncated: boolean
    cursor?: string
  }>
}

export interface Env {
  readonly ECHO_PDF_CONFIG_JSON?: string
  readonly ASSETS?: Fetcher
  readonly FILE_STORE_BUCKET?: R2Bucket
  readonly FILE_STORE_DO?: DurableObjectNamespace
  readonly [key: string]: string | Fetcher | DurableObjectNamespace | R2Bucket | undefined
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
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
