import type { ReturnMode, StoredFileRecord } from "./types.js"

export const fromBase64 = (value: string): Uint8Array => {
  const raw = atob(value.replace(/^data:.*;base64,/, ""))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i)
  }
  return out
}

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export const toDataUrl = (bytes: Uint8Array, mimeType: string): string =>
  `data:${mimeType};base64,${toBase64(bytes)}`

export const normalizeReturnMode = (value: unknown): ReturnMode => {
  if (value === "file_id" || value === "url" || value === "inline") {
    return value
  }
  return "inline"
}

export const toInlineFilePayload = (file: StoredFileRecord, includeBase64: boolean): Record<string, unknown> => ({
  file: {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt,
  },
  dataUrl: file.mimeType.startsWith("image/") ? toDataUrl(file.bytes, file.mimeType) : undefined,
  base64: includeBase64 ? toBase64(file.bytes) : undefined,
  text: file.mimeType.startsWith("text/") ? new TextDecoder().decode(file.bytes) : undefined,
})
