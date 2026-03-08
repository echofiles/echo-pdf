import { normalizeReturnMode } from "./file-utils"
import { runFileOp } from "./file-ops"
import { runPdfAgent } from "./pdf-agent"
import type { EchoPdfConfig, PdfOperationRequest, ToolSchema } from "./pdf-types"
import type { Env, FileStore, JsonObject } from "./types"

export interface ToolRuntimeContext {
  readonly config: EchoPdfConfig
  readonly env: Env
  readonly fileStore: FileStore
  readonly providerApiKeys?: Record<string, string>
  readonly trace?: (event: { kind: "step"; phase: "start" | "end" | "log"; name: string; payload?: unknown }) => void
}

interface ToolDefinition {
  readonly schema: ToolSchema
  run: (ctx: ToolRuntimeContext, args: JsonObject) => Promise<unknown>
}

const asNumberArray = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0) : []

const asObject = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}

const readString = (obj: JsonObject, key: string): string | undefined => {
  const value = obj[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const toolDefinitions: ReadonlyArray<ToolDefinition> = [
  {
    schema: {
      name: "pdf_extract_pages",
      description: "Render specific PDF pages to image and return inline/file_id/url mode.",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          url: { type: "string" },
          base64: { type: "string" },
          filename: { type: "string" },
          pages: { type: "array", items: { type: "integer" } },
          renderScale: { type: "number" },
          returnMode: { type: "string", enum: ["inline", "file_id", "url"] },
        },
        required: ["pages"],
      },
      source: { kind: "local", toolName: "pdf.extract_pages" },
    },
    run: async (ctx, args) => {
      const req: PdfOperationRequest = {
        operation: "extract_pages",
        fileId: readString(args, "fileId"),
        url: readString(args, "url"),
        base64: readString(args, "base64"),
        filename: readString(args, "filename"),
        pages: asNumberArray(args.pages),
        renderScale: typeof args.renderScale === "number" ? args.renderScale : undefined,
        provider: undefined,
        model: "not-required",
        providerApiKeys: ctx.providerApiKeys,
        returnMode: normalizeReturnMode(args.returnMode),
      }
      return runPdfAgent(ctx.config, ctx.env, req, {
        fileStore: ctx.fileStore,
        trace: ctx.trace,
      })
    },
  },
  {
    schema: {
      name: "pdf_ocr_pages",
      description: "OCR specific PDF pages using configured multimodal model.",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          url: { type: "string" },
          base64: { type: "string" },
          filename: { type: "string" },
          pages: { type: "array", items: { type: "integer" } },
          renderScale: { type: "number" },
          provider: { type: "string" },
          model: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["pages"],
      },
      source: { kind: "local", toolName: "pdf.ocr_pages" },
    },
    run: async (ctx, args) => {
      const req: PdfOperationRequest = {
        operation: "ocr_pages",
        fileId: readString(args, "fileId"),
        url: readString(args, "url"),
        base64: readString(args, "base64"),
        filename: readString(args, "filename"),
        pages: asNumberArray(args.pages),
        renderScale: typeof args.renderScale === "number" ? args.renderScale : undefined,
        provider: readString(args, "provider"),
        model: readString(args, "model") ?? "",
        prompt: readString(args, "prompt"),
        providerApiKeys: ctx.providerApiKeys,
        returnMode: "inline",
      }
      return runPdfAgent(ctx.config, ctx.env, req, {
        fileStore: ctx.fileStore,
        trace: ctx.trace,
      })
    },
  },
  {
    schema: {
      name: "pdf_tables_to_latex",
      description: "Recognize tables from pages and return LaTeX tabular output.",
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          url: { type: "string" },
          base64: { type: "string" },
          filename: { type: "string" },
          pages: { type: "array", items: { type: "integer" } },
          renderScale: { type: "number" },
          provider: { type: "string" },
          model: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["pages"],
      },
      source: { kind: "local", toolName: "pdf.tables_to_latex" },
    },
    run: async (ctx, args) => {
      const req: PdfOperationRequest = {
        operation: "tables_to_latex",
        fileId: readString(args, "fileId"),
        url: readString(args, "url"),
        base64: readString(args, "base64"),
        filename: readString(args, "filename"),
        pages: asNumberArray(args.pages),
        renderScale: typeof args.renderScale === "number" ? args.renderScale : undefined,
        provider: readString(args, "provider"),
        model: readString(args, "model") ?? "",
        prompt: readString(args, "prompt"),
        providerApiKeys: ctx.providerApiKeys,
        returnMode: "inline",
      }
      return runPdfAgent(ctx.config, ctx.env, req, {
        fileStore: ctx.fileStore,
        trace: ctx.trace,
      })
    },
  },
  {
    schema: {
      name: "file_ops",
      description: "Basic file operations: list/read/delete/put for runtime file store.",
      inputSchema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "read", "delete", "put"] },
          fileId: { type: "string" },
          includeBase64: { type: "boolean" },
          text: { type: "string" },
          filename: { type: "string" },
          mimeType: { type: "string" },
          base64: { type: "string" },
          returnMode: { type: "string", enum: ["inline", "file_id", "url"] },
        },
        required: ["op"],
      },
      source: { kind: "local", toolName: "file.ops" },
    },
    run: async (ctx, args) =>
      runFileOp(ctx.fileStore, {
        op: (readString(args, "op") as "list" | "read" | "delete" | "put") ?? "list",
        fileId: readString(args, "fileId"),
        includeBase64: Boolean(args.includeBase64),
        text: readString(args, "text"),
        filename: readString(args, "filename"),
        mimeType: readString(args, "mimeType"),
        base64: readString(args, "base64"),
        returnMode: normalizeReturnMode(args.returnMode),
      }),
  },
]

export const listToolSchemas = (): ReadonlyArray<ToolSchema> => toolDefinitions.map((item) => item.schema)

export const callTool = async (
  name: string,
  args: unknown,
  ctx: ToolRuntimeContext
): Promise<unknown> => {
  const definition = toolDefinitions.find((item) => item.schema.name === name)
  if (!definition) {
    throw new Error(`Unknown tool: ${name}`)
  }
  return definition.run(ctx, asObject(args))
}
