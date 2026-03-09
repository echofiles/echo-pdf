import type { Env, FileStore, ReturnMode } from "./types.js"
import type { AgentTraceEvent, EchoPdfConfig, PdfOperationRequest } from "./pdf-types.js"
import { resolveModelForProvider, resolveProviderAlias } from "./agent-defaults.js"
import { fromBase64, normalizeReturnMode, toDataUrl } from "./file-utils.js"
import { badRequest, notFound, unprocessable } from "./http-error.js"
import { extractPdfPageText, getPdfPageCount, renderPdfPageToPng, toBytes } from "./pdfium-engine.js"
import { visionRecognize } from "./provider-client.js"

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
  if (pages.length === 0) throw badRequest("PAGES_REQUIRED", "At least one page is required")
  if (pages.length > maxPages) {
    throw badRequest("TOO_MANY_PAGES", `Page count exceeds maxPagesPerRequest (${maxPages})`, {
      maxPagesPerRequest: maxPages,
      providedPages: pages.length,
    })
  }
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw badRequest("PAGE_OUT_OF_RANGE", `Page ${page} out of range 1..${pageCount}`, {
        page,
        min: 1,
        max: pageCount,
      })
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
      throw notFound("FILE_NOT_FOUND", `File not found: ${input.fileId}`, { fileId: input.fileId })
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
    try {
      bytes = await toBytes(input.url)
    } catch (error) {
      throw badRequest("URL_FETCH_FAILED", `Unable to fetch PDF from url: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    throw badRequest("MISSING_FILE_INPUT", "Missing file input. Provide fileId, url or base64")
  }
  if (bytes.byteLength > config.service.maxPdfBytes) {
    throw badRequest("PDF_TOO_LARGE", `PDF exceeds max size (${config.service.maxPdfBytes} bytes)`, {
      maxPdfBytes: config.service.maxPdfBytes,
      sizeBytes: bytes.byteLength,
    })
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

const stripCodeFences = (value: string): string => {
  const text = value.trim()
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return typeof fenced?.[1] === "string" ? fenced[1].trim() : text
}

const extractTabularLatex = (value: string): string => {
  const text = stripCodeFences(value)
  const blocks = text.match(/\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/g)
  if (!blocks || blocks.length === 0) return ""
  return blocks.map((b) => b.trim()).join("\n\n")
}

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
        images.push({
          page,
          mimeType: "image/png",
          fileId: stored.id,
          url: `/api/files/get?fileId=${encodeURIComponent(stored.id)}`,
        })
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

  const providerAlias = resolveProviderAlias(config, request.provider)
  const model = resolveModelForProvider(config, providerAlias, request.model)
  if (!model) {
    throw badRequest("MODEL_REQUIRED", "model is required for OCR or table extraction; set agent.defaultModel")
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
      const text = stripCodeFences(llmText || fallbackText || "")
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
    const rawLatex = await visionRecognize({
      config,
      env,
      providerAlias,
      model,
      prompt,
      imageDataUrl,
      runtimeApiKeys: request.providerApiKeys,
    })
    const latex = extractTabularLatex(rawLatex)
    if (!latex) {
      throw unprocessable("TABLE_LATEX_MISSING", `table extraction did not return valid LaTeX tabular for page ${page}`, {
        page,
      })
    }
    tables.push({ page, latex })
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
