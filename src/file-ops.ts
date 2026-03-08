import { fromBase64, normalizeReturnMode, toInlineFilePayload } from "./file-utils"
import type { FileStore, ReturnMode } from "./types"

export const runFileOp = async (
  fileStore: FileStore,
  input: {
    readonly op: "list" | "read" | "delete" | "put"
    readonly fileId?: string
    readonly includeBase64?: boolean
    readonly text?: string
    readonly filename?: string
    readonly mimeType?: string
    readonly base64?: string
    readonly returnMode?: ReturnMode
  }
): Promise<unknown> => {
  if (input.op === "list") {
    return { files: await fileStore.list() }
  }

  if (input.op === "put") {
    const bytes = input.base64 ? fromBase64(input.base64) : new TextEncoder().encode(input.text ?? "")
    const meta = await fileStore.put({
      filename: input.filename ?? `file-${Date.now()}.txt`,
      mimeType: input.mimeType ?? "text/plain; charset=utf-8",
      bytes,
    })
    const returnMode = normalizeReturnMode(input.returnMode)
    if (returnMode === "file_id") return { returnMode, file: meta }
    if (returnMode === "url") return { returnMode, file: meta, url: null }
    const stored = await fileStore.get(meta.id)
    if (!stored) throw new Error(`File not found after put: ${meta.id}`)
    return {
      returnMode,
      ...toInlineFilePayload(stored, true),
    }
  }

  if (!input.fileId) {
    throw new Error("fileId is required")
  }

  if (input.op === "delete") {
    return { deleted: await fileStore.delete(input.fileId), fileId: input.fileId }
  }

  const file = await fileStore.get(input.fileId)
  if (!file) throw new Error(`File not found: ${input.fileId}`)
  return toInlineFilePayload(file, Boolean(input.includeBase64))
}
