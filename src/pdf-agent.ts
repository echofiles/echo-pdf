import type { Env, FileStore, ReturnMode } from "./types"
import type { AgentTraceEvent, EchoPdfConfig, PdfOperationRequest } from "./pdf-types"
import { fromBase64, normalizeReturnMode, toInlineFilePayload, toDataUrl } from "./file-utils"
import { extractPdfPageText, getPdfPageCount, renderPdfPageToPng, toBytes } from "./pdfium-engine"
import { visionRecognize } from "./provider-client"

interface RuntimeOptions {
  readonly trace?: (event: AgentTraceEvent) => void
  readonly fileStore: FileStore
}

const traceStep = (
  opts: RuntimeOptions,
  phase: AgentTraceEvent["phase"],
  name: string,
  payload?: unknown,
  level?: AgentTraceEvent["level"]
): void => {
  if (!opts.trace) return
  opts.trace({ kind: "step", phase, name, payload, level })
}

const ensurePages = (pages: ReadonlyArray<number>, pageCount: number, maxPages: number): number[] => {
  if (pages.length === 0) throw new Error("At least one page is required")
  if (pages.length > maxPages) throw new Error(`Page count exceeds maxPagesPerRequest (${maxPages})`)
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`Page ${page} out of range 1..${pageCount}`)
    }
  }
  return [...new Set(pages)].sort((a, b) => a - b)
}

export const ingestPdfFromPayload = async (
  config: EchoPdfConfig,
  input: {
    readonly fileId?: string
    readonly url?: string
    readonly base64?: string
    readonly filename?: string
  },
  opts: RuntimeOptions
): Promise<{ id: string; filename: string; bytes: Uint8Array }> => {
  if (input.fileId) {
    const existing = await opts.fileStore.get(input.fileId)
    if (!existing) {
      throw new Error(`File not found: ${input.fileId}`)
    }
    return {
      id: existing.id,
      filename: existing.filename,
      bytes: existing.bytes,
    }
  }

  let bytes: Uint8Array | null = null
  let filename = input.filename ?? "document.pdf"

  if (input.url) {
    traceStep(opts, "start", "file.fetch.url", { url: input.url })
    bytes = await toBytes(input.url)
    try {
      const u = new URL(input.url)
      filename = decodeURIComponent(u.pathname.split("/").pop() || filename)
    } catch {
      // ignore URL parse failure
    }
    traceStep(opts, "end", "file.fetch.url", { sizeBytes: bytes.byteLength })
  } else if (input.base64) {
    traceStep(opts, "start", "file.decode.base64")
    bytes = fromBase64(input.base64)
    traceStep(opts, "end", "file.decode.base64", { sizeBytes: bytes.byteLength })
  }

  if (!bytes) {
    throw new Error("Missing file input. Provide fileId, url or base64")
  }
  if (bytes.byteLength > config.service.maxPdfBytes) {
    throw new Error(`PDF exceeds max size (${config.service.maxPdfBytes} bytes)`)
  }

  const meta = await opts.fileStore.put({
    filename,
    mimeType: "application/pdf",
    bytes,
  })
  traceStep(opts, "end", "file.stored", { fileId: meta.id, sizeBytes: meta.sizeBytes })
  return {
    id: meta.id,
    filename: meta.filename,
    bytes,
  }
}

const resolveReturnMode = (value: ReturnMode | undefined): ReturnMode => normalizeReturnMode(value)

export const runPdfAgent = async (
  config: EchoPdfConfig,
  env: Env,
  request: PdfOperationRequest,
  opts: RuntimeOptions
): Promise<unknown> => {
  traceStep(opts, "start", "pdf.operation", { operation: request.operation })
  const file = await ingestPdfFromPayload(config, request, opts)
  const pageCount = await getPdfPageCount(config, file.bytes)
  traceStep(opts, "log", "pdf.meta", { fileId: file.id, pageCount })

  const pages = ensurePages(request.pages, pageCount, config.service.maxPagesPerRequest)
  const scale = request.renderScale ?? config.service.defaultRenderScale
  const returnMode = resolveReturnMode(request.returnMode)

  if (request.operation === "extract_pages") {
    const images: Array<{ page: number; mimeType: string; data?: string; fileId?: string; url?: string | null }> = []
    for (const page of pages) {
      traceStep(opts, "start", "render.page", { page })
      const rendered = await renderPdfPageToPng(config, file.bytes, page - 1, scale)
      if (returnMode === "file_id") {
        const stored = await opts.fileStore.put({
          filename: `${file.filename}-p${page}.png`,
          mimeType: "image/png",
          bytes: rendered.png,
        })
        images.push({ page, mimeType: "image/png", fileId: stored.id })
      } else if (returnMode === "url") {
        const stored = await opts.fileStore.put({
          filename: `${file.filename}-p${page}.png`,
          mimeType: "image/png",
          bytes: rendered.png,
        })
        images.push({ page, mimeType: "image/png", fileId: stored.id, url: null })
      } else {
        images.push({
          page,
          mimeType: "image/png",
          data: toDataUrl(rendered.png, "image/png"),
        })
      }
      traceStep(opts, "end", "render.page", { page, width: rendered.width, height: rendered.height })
    }
    const result = { fileId: file.id, pageCount, returnMode, images }
    traceStep(opts, "end", "pdf.operation", { operation: request.operation })
    return result
  }

  const providerAlias = request.provider ?? config.agent.defaultProvider
  const model = request.model?.trim() || config.agent.defaultModel?.trim()
  if (!model) {
    throw new Error("model is required for OCR or table extraction; set model in top-level provider settings")
  }

  if (request.operation === "ocr_pages") {
    const results: Array<{ page: number; text: string }> = []
    for (const page of pages) {
      traceStep(opts, "start", "ocr.page", { page })
      const rendered = await renderPdfPageToPng(config, file.bytes, page - 1, scale)
      const imageDataUrl = toDataUrl(rendered.png, "image/png")
      const fallbackText = await extractPdfPageText(config, file.bytes, page - 1)
      const prompt = request.prompt?.trim() || config.agent.ocrPrompt
      const llmText = await visionRecognize({
        config,
        env,
        providerAlias,
        model,
        prompt,
        imageDataUrl,
        runtimeApiKeys: request.providerApiKeys,
      })
      const text = (llmText || fallbackText || "").trim()
      results.push({ page, text })
      traceStep(opts, "end", "ocr.page", { page, chars: text.length })
    }
    const result = {
      fileId: file.id,
      pageCount,
      provider: providerAlias,
      model,
      pages: results,
    }
    traceStep(opts, "end", "pdf.operation", { operation: request.operation })
    return result
  }

  const tables: Array<{ page: number; latex: string }> = []
  for (const page of pages) {
    traceStep(opts, "start", "table.page", { page })
    const rendered = await renderPdfPageToPng(config, file.bytes, page - 1, scale)
    const imageDataUrl = toDataUrl(rendered.png, "image/png")
    const prompt = request.prompt?.trim() || config.agent.tablePrompt
    const latex = await visionRecognize({
      config,
      env,
      providerAlias,
      model,
      prompt,
      imageDataUrl,
      runtimeApiKeys: request.providerApiKeys,
    })
    tables.push({ page, latex: latex.trim() })
    traceStep(opts, "end", "table.page", { page, chars: latex.length })
  }
  const result = {
    fileId: file.id,
    pageCount,
    provider: providerAlias,
    model,
    pages: tables,
  }
  traceStep(opts, "end", "pdf.operation", { operation: request.operation })
  return result
}

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
    const returnMode = resolveReturnMode(input.returnMode)
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
