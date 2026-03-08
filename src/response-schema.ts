import type { JsonObject } from "./types"

export interface ToolArtifact {
  readonly id?: string
  readonly kind: "image" | "pdf" | "file" | "json" | "text"
  readonly mimeType?: string
  readonly filename?: string
  readonly sizeBytes?: number
  readonly url?: string
}

export interface ToolOutputEnvelope {
  readonly ok: true
  readonly data: unknown
  readonly artifacts: ToolArtifact[]
}

const MAX_TEXT_STRING = 1200
const MAX_TEXT_ARRAY = 40
const MAX_TEXT_DEPTH = 8

const asObj = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}

const inferKind = (mimeType?: string): ToolArtifact["kind"] => {
  const mime = (mimeType || "").toLowerCase()
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime.includes("json")) return "json"
  if (mime.startsWith("text/")) return "text"
  return "file"
}

const toAbsoluteUrl = (value: string, baseUrl: string): string => {
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

const addArtifact = (artifacts: ToolArtifact[], artifact: ToolArtifact): void => {
  if (!artifact.id && !artifact.url && !artifact.filename) return
  artifacts.push(artifact)
}

export const buildToolOutputEnvelope = (
  result: unknown,
  baseUrl: string
): ToolOutputEnvelope => {
  const root = asObj(result)
  const artifacts: ToolArtifact[] = []

  const fileMeta = asObj(root.file)
  if (typeof fileMeta.id === "string") {
    addArtifact(artifacts, {
      id: fileMeta.id,
      kind: inferKind(typeof fileMeta.mimeType === "string" ? fileMeta.mimeType : undefined),
      mimeType: typeof fileMeta.mimeType === "string" ? fileMeta.mimeType : undefined,
      filename: typeof fileMeta.filename === "string" ? fileMeta.filename : undefined,
      sizeBytes: typeof fileMeta.sizeBytes === "number" ? fileMeta.sizeBytes : undefined,
      url: typeof root.url === "string" ? toAbsoluteUrl(root.url, baseUrl) : undefined,
    })
  }

  const images = Array.isArray(root.images) ? root.images : []
  for (const item of images) {
    const image = asObj(item)
    const fileId = typeof image.fileId === "string" ? image.fileId : undefined
    const rawUrl = typeof image.url === "string" ? image.url : undefined
    if (!fileId && !rawUrl) continue
    addArtifact(artifacts, {
      id: fileId,
      kind: "image",
      mimeType: typeof image.mimeType === "string" ? image.mimeType : "image/png",
      filename: fileId ? `artifact-${fileId}.png` : undefined,
      url: rawUrl ? toAbsoluteUrl(rawUrl, baseUrl) : undefined,
    })
  }

  const files = Array.isArray(root.files) ? root.files : []
  for (const item of files) {
    const meta = asObj(item)
    if (typeof meta.id !== "string") continue
    addArtifact(artifacts, {
      id: meta.id,
      kind: inferKind(typeof meta.mimeType === "string" ? meta.mimeType : undefined),
      mimeType: typeof meta.mimeType === "string" ? meta.mimeType : undefined,
      filename: typeof meta.filename === "string" ? meta.filename : undefined,
      sizeBytes: typeof meta.sizeBytes === "number" ? meta.sizeBytes : undefined,
    })
  }

  return {
    ok: true,
    data: result,
    artifacts,
  }
}

const summarizeData = (data: unknown): string => {
  const root = asObj(data)
  if (typeof root.returnMode === "string" && Array.isArray(root.images)) {
    return `Extracted ${root.images.length} page image(s) in returnMode=${root.returnMode}.`
  }
  if (Array.isArray(root.pages)) {
    return `Processed ${root.pages.length} page(s).`
  }
  if (Array.isArray(root.files)) {
    return `Listed ${root.files.length} file(s).`
  }
  if (typeof root.deleted === "boolean") {
    return root.deleted ? "File deleted." : "File not found."
  }
  return "Tool executed successfully."
}

const sanitizeString = (value: string): string => {
  if (value.startsWith("data:")) {
    const [head] = value.split(",", 1)
    return `${head},<omitted>`
  }
  if (/^[A-Za-z0-9+/=]{300,}$/.test(value)) {
    return `<base64 omitted len=${value.length}>`
  }
  if (value.length > MAX_TEXT_STRING) {
    return `${value.slice(0, MAX_TEXT_STRING)}...(truncated ${value.length - MAX_TEXT_STRING} chars)`
  }
  return value
}

const sanitizeForText = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_TEXT_DEPTH) return "<max-depth>"
  if (typeof value === "string") return sanitizeString(value)
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_TEXT_ARRAY).map((item) => sanitizeForText(item, depth + 1))
    if (value.length > MAX_TEXT_ARRAY) {
      items.push(`<truncated ${value.length - MAX_TEXT_ARRAY} items>`)
    }
    return items
  }
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    out[key] = sanitizeForText(nested, depth + 1)
  }
  return out
}

export const buildMcpContent = (envelope: ToolOutputEnvelope): Array<Record<string, unknown>> => {
  const lines: string[] = [summarizeData(envelope.data)]
  if (envelope.artifacts.length > 0) {
    lines.push("Artifacts:")
    for (const artifact of envelope.artifacts) {
      const descriptor = [
        artifact.kind,
        artifact.filename ?? artifact.id ?? "artifact",
        artifact.mimeType ?? "",
        artifact.url ?? "",
      ]
        .filter((v) => v.length > 0)
        .join(" | ")
      lines.push(`- ${descriptor}`)
    }
  }
  lines.push("")
  lines.push(JSON.stringify(sanitizeForText(envelope), null, 2))

  const content: Array<Record<string, unknown>> = [{ type: "text", text: lines.join("\n") }]
  for (const artifact of envelope.artifacts) {
    if (!artifact.url) continue
    content.push({
      type: "resource_link",
      name: artifact.filename ?? artifact.id ?? "artifact",
      uri: artifact.url,
      mimeType: artifact.mimeType ?? "application/octet-stream",
    })
  }
  return content
}
