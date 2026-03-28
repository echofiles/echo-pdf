/// <reference path="./compat.d.ts" />

import { init } from "@embedpdf/pdfium"
import type { WrappedPdfiumModule } from "@embedpdf/pdfium"
import type { EchoPdfConfig } from "../pdf-types.js"

let moduleInstance: WrappedPdfiumModule | null = null
let libraryInitialized = false

const isNodeRuntime = (): boolean =>
  typeof process !== "undefined" && Boolean(process.versions?.node)

const ensureWasmFunctionShim = (): void => {
  const wasmApi = WebAssembly as unknown as {
    Function?: unknown
  }
  if (typeof wasmApi.Function === "function") return
  ;(wasmApi as { Function: (sig: unknown, fn: unknown) => unknown }).Function = (
    _sig: unknown,
    fn: unknown
  ) => fn
}

const readLocalPdfiumWasm = async (): Promise<ArrayBuffer> => {
  const [{ readFile }, { createRequire }] = await Promise.all([
    import("node:fs/promises"),
    import("node:module"),
  ])
  const require = createRequire(import.meta.url)
  const bytes = await readFile(require.resolve("@embedpdf/pdfium/pdfium.wasm"))
  return new Uint8Array(bytes).slice().buffer
}

const ensureLocalPdfium = async (_config: EchoPdfConfig): Promise<WrappedPdfiumModule> => {
  if (!isNodeRuntime()) {
    throw new Error("local document APIs require a Node-compatible runtime")
  }
  ensureWasmFunctionShim()
  if (!moduleInstance) {
    moduleInstance = await init({ wasmBinary: await readLocalPdfiumWasm() })
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

const decodeUtf16Le = (buf: Uint8Array): string => {
  const view = new Uint16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
  const chars: number[] = []
  for (const code of view) {
    if (code === 0) break
    chars.push(code)
  }
  return String.fromCharCode(...chars)
}

export const getLocalPdfPageCount = async (config: EchoPdfConfig, bytes: Uint8Array): Promise<number> => {
  const pdfium = await ensureLocalPdfium(config)
  const { doc, memPtr } = makeDoc(pdfium, bytes)
  try {
    return pdfium.FPDF_GetPageCount(doc)
  } finally {
    closeDoc(pdfium, doc, memPtr)
  }
}

export const extractLocalPdfPageText = async (
  config: EchoPdfConfig,
  bytes: Uint8Array,
  pageIndex: number
): Promise<string> => {
  const pdfium = await ensureLocalPdfium(config)
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
