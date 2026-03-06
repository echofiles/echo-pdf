import { init } from "@embedpdf/pdfium"
import { encode as encodePng } from "@cf-wasm/png/workerd"
import type { WrappedPdfiumModule } from "@embedpdf/pdfium"
import type { EchoPdfConfig } from "./pdf-types"
import { toDataUrl } from "./file-utils"

let moduleInstance: WrappedPdfiumModule | null = null
let libraryInitialized = false

const toUint8 = (value: ArrayBuffer): Uint8Array => new Uint8Array(value)
const textDecoder = new TextDecoder()

const ensurePdfium = async (config: EchoPdfConfig): Promise<WrappedPdfiumModule> => {
  if (!moduleInstance) {
    const wasmBinary = await fetch(config.pdfium.wasmUrl).then((res) => res.arrayBuffer())
    moduleInstance = await init({ wasmBinary })
  }
  if (!libraryInitialized) {
    moduleInstance.FPDF_InitLibrary()
    libraryInitialized = true
  }
  return moduleInstance
}

const makeDoc = (pdfium: WrappedPdfiumModule, bytes: Uint8Array): {
  readonly doc: number
  readonly memPtr: number
} => {
  const memPtr = pdfium.pdfium.wasmExports.malloc(bytes.length)
  ;(pdfium.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8.set(bytes, memPtr)
  const doc = pdfium.FPDF_LoadMemDocument(memPtr, bytes.length, "")
  if (!doc) {
    pdfium.pdfium.wasmExports.free(memPtr)
    throw new Error("Failed to load PDF document")
  }
  return { doc, memPtr }
}

const closeDoc = (pdfium: WrappedPdfiumModule, doc: number, memPtr: number): void => {
  pdfium.FPDF_CloseDocument(doc)
  pdfium.pdfium.wasmExports.free(memPtr)
}

const bgraToRgba = (bgra: Uint8Array): Uint8Array => {
  const rgba = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2] ?? 0
    rgba[i + 1] = bgra[i + 1] ?? 0
    rgba[i + 2] = bgra[i] ?? 0
    rgba[i + 3] = bgra[i + 3] ?? 255
  }
  return rgba
}

const decodeUtf16Le = (buf: Uint8Array): string => {
  const view = new Uint16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
  const chars: number[] = []
  for (const code of view) {
    if (code === 0) break
    chars.push(code)
  }
  return String.fromCharCode(...chars)
}

export const getPdfPageCount = async (config: EchoPdfConfig, bytes: Uint8Array): Promise<number> => {
  const pdfium = await ensurePdfium(config)
  const { doc, memPtr } = makeDoc(pdfium, bytes)
  try {
    return pdfium.FPDF_GetPageCount(doc)
  } finally {
    closeDoc(pdfium, doc, memPtr)
  }
}

export const renderPdfPageToPng = async (
  config: EchoPdfConfig,
  bytes: Uint8Array,
  pageIndex: number,
  scale = config.service.defaultRenderScale
): Promise<{
  width: number
  height: number
  png: Uint8Array
}> => {
  const pdfium = await ensurePdfium(config)
  const { doc, memPtr } = makeDoc(pdfium, bytes)
  let page = 0
  let bitmap = 0
  try {
    page = pdfium.FPDF_LoadPage(doc, pageIndex)
    if (!page) {
      throw new Error(`Failed to load page ${pageIndex}`)
    }
    const width = Math.max(1, Math.round(pdfium.FPDF_GetPageWidthF(page) * scale))
    const height = Math.max(1, Math.round(pdfium.FPDF_GetPageHeightF(page) * scale))
    bitmap = pdfium.FPDFBitmap_Create(width, height, 1)
    if (!bitmap) {
      throw new Error("Failed to create bitmap")
    }
    pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
    pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)

    const stride = pdfium.FPDFBitmap_GetStride(bitmap)
    const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmap)
    const heap = (pdfium.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
    const bgra = heap.slice(bufferPtr, bufferPtr + stride * height)
    const rgba = bgraToRgba(bgra)
    const png = encodePng(rgba, width, height)
    return { width, height, png }
  } finally {
    if (bitmap) pdfium.FPDFBitmap_Destroy(bitmap)
    if (page) pdfium.FPDF_ClosePage(page)
    closeDoc(pdfium, doc, memPtr)
  }
}

export const extractPdfPageText = async (
  config: EchoPdfConfig,
  bytes: Uint8Array,
  pageIndex: number
): Promise<string> => {
  const pdfium = await ensurePdfium(config)
  const { doc, memPtr } = makeDoc(pdfium, bytes)
  let page = 0
  let textPage = 0
  let outPtr = 0
  try {
    page = pdfium.FPDF_LoadPage(doc, pageIndex)
    if (!page) {
      throw new Error(`Failed to load page ${pageIndex}`)
    }
    textPage = pdfium.FPDFText_LoadPage(page)
    if (!textPage) return ""
    const chars = pdfium.FPDFText_CountChars(textPage)
    if (chars <= 0) return ""
    const bytesLen = (chars + 1) * 2
    outPtr = pdfium.pdfium.wasmExports.malloc(bytesLen)
    pdfium.FPDFText_GetText(textPage, 0, chars, outPtr)
    const heap = (pdfium.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
    const raw = heap.slice(outPtr, outPtr + bytesLen)
    return decodeUtf16Le(raw).trim()
  } finally {
    if (outPtr) pdfium.pdfium.wasmExports.free(outPtr)
    if (textPage) pdfium.FPDFText_ClosePage(textPage)
    if (page) pdfium.FPDF_ClosePage(page)
    closeDoc(pdfium, doc, memPtr)
  }
}

export const toBytes = async (value: string): Promise<Uint8Array> => {
  const response = await fetch(value)
  if (!response.ok) {
    throw new Error(`Failed to fetch source: HTTP ${response.status}`)
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  const bytes = toUint8(await response.arrayBuffer())
  const signature = textDecoder.decode(bytes.subarray(0, Math.min(8, bytes.length)))

  if (contentType.includes("application/pdf") || signature.startsWith("%PDF-")) {
    return bytes
  }

  const html = textDecoder.decode(bytes)
  const pdfMatch = html.match(/https?:\/\/[^"' )]+\.pdf[^"' )]*/i)
  if (!pdfMatch || pdfMatch.length === 0) {
    throw new Error("URL does not point to a PDF and no PDF link was found in the page")
  }

  const resolvedUrl = pdfMatch[0].replace(/&amp;/g, "&")
  const pdfResponse = await fetch(resolvedUrl)
  if (!pdfResponse.ok) {
    throw new Error(`Failed to fetch resolved PDF url: HTTP ${pdfResponse.status}`)
  }
  const pdfBytes = toUint8(await pdfResponse.arrayBuffer())
  const pdfSignature = textDecoder.decode(pdfBytes.subarray(0, Math.min(8, pdfBytes.length)))
  if (!pdfSignature.startsWith("%PDF-")) {
    throw new Error("Resolved file is not a valid PDF")
  }
  return pdfBytes
}
