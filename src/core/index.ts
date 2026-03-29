export { callTool, listToolSchemas } from "../tool-registry.js"
export type { ToolRuntimeContext } from "../tool-registry.js"
export type { ToolSchema } from "../pdf-types.js"
export type { Env, FileStore, JsonObject } from "../types.js"
import { callTool } from "../tool-registry.js"
import type { JsonObject } from "../types.js"
import type { ReturnMode } from "../types.js"

export interface PdfExtractPagesArgs {
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly filename?: string
  readonly pages: ReadonlyArray<number>
  readonly renderScale?: number
  readonly returnMode?: ReturnMode
}

export interface PdfTablesToLatexArgs {
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly filename?: string
  readonly pages: ReadonlyArray<number>
  readonly renderScale?: number
  readonly provider?: string
  readonly model?: string
  readonly prompt?: string
}

export interface FileOpsArgs {
  readonly op: "list" | "read" | "delete" | "put"
  readonly fileId?: string
  readonly includeBase64?: boolean
  readonly text?: string
  readonly filename?: string
  readonly mimeType?: string
  readonly base64?: string
  readonly returnMode?: ReturnMode
}

const asJsonObject = (value: unknown): JsonObject => value as JsonObject

export const pdf_extract_pages = async (
  args: PdfExtractPagesArgs,
  ctx: import("../tool-registry.js").ToolRuntimeContext
): Promise<unknown> => callTool("pdf_extract_pages", asJsonObject(args), ctx)

export const pdf_tables_to_latex = async (
  args: PdfTablesToLatexArgs,
  ctx: import("../tool-registry.js").ToolRuntimeContext
): Promise<unknown> => callTool("pdf_tables_to_latex", asJsonObject(args), ctx)

export const file_ops = async (
  args: FileOpsArgs,
  ctx: import("../tool-registry.js").ToolRuntimeContext
): Promise<unknown> => callTool("file_ops", asJsonObject(args), ctx)
