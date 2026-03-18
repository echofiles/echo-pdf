import { normalizeReturnMode } from "./file-utils.js"
import { FileStoreDO } from "./file-store-do.js"
import { resolveModelForProvider, resolveProviderAlias } from "./agent-defaults.js"
import { checkHeaderAuth } from "./auth.js"
import { handleMcpRequest } from "./mcp-server.js"
import { loadEchoPdfConfig } from "./pdf-config.js"
import { getRuntimeFileStore } from "./pdf-storage.js"
import { listProviderModels } from "./provider-client.js"
import { buildToolOutputEnvelope } from "./response-schema.js"
import { callTool, listToolSchemas } from "./tool-registry.js"
import type { AgentTraceEvent, PdfOperationRequest } from "./pdf-types.js"
import type { Env, JsonObject, WorkerExecutionContext } from "./types.js"

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })

const toError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const errorStatus = (error: unknown): number | null => {
  const status = (error as { status?: unknown })?.status
  return typeof status === "number" && Number.isFinite(status) ? status : null
}

const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" && code.length > 0 ? code : null
}

const errorDetails = (error: unknown): unknown => (error as { details?: unknown })?.details

const jsonError = (error: unknown, fallbackStatus = 500): Response => {
  const status = errorStatus(error) ?? fallbackStatus
  const code = errorCode(error)
  const details = errorDetails(error)
  return json({ error: toError(error), code, details }, status)
}

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body = await request.json()
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

const asObj = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}

const resolvePublicBaseUrl = (request: Request, configured?: string): string =>
  typeof configured === "string" && configured.length > 0 ? configured : request.url

const sanitizeDownloadFilename = (filename: string): string => {
  const cleaned = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[^\x20-\x7E]+/g, "")
    .trim()
  return cleaned.length > 0 ? cleaned : "download.bin"
}

const sseResponse = (stream: ReadableStream<Uint8Array>): Response =>
  new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  })

const encodeSse = (event: string, data: unknown): Uint8Array => {
  const encoder = new TextEncoder()
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const isValidOperation = (value: unknown): value is PdfOperationRequest["operation"] =>
  value === "extract_pages" || value === "ocr_pages" || value === "tables_to_latex"

const toPdfOperation = (input: Record<string, unknown>, defaultProvider: string): PdfOperationRequest => ({
  operation: isValidOperation(input.operation) ? input.operation : "extract_pages",
  fileId: typeof input.fileId === "string" ? input.fileId : undefined,
  url: typeof input.url === "string" ? input.url : undefined,
  base64: typeof input.base64 === "string" ? input.base64 : undefined,
  filename: typeof input.filename === "string" ? input.filename : undefined,
  pages: Array.isArray(input.pages) ? input.pages.map((v) => Number(v)) : [],
  renderScale: typeof input.renderScale === "number" ? input.renderScale : undefined,
  provider: typeof input.provider === "string" ? input.provider : defaultProvider,
  model: typeof input.model === "string" ? input.model : "",
  providerApiKeys: typeof input.providerApiKeys === "object" && input.providerApiKeys !== null
    ? (input.providerApiKeys as Record<string, string>)
    : undefined,
  returnMode: normalizeReturnMode(input.returnMode),
  prompt: typeof input.prompt === "string" ? input.prompt : undefined,
})

const toolNameByOperation: Record<PdfOperationRequest["operation"], string> = {
  extract_pages: "pdf_extract_pages",
  ocr_pages: "pdf_ocr_pages",
  tables_to_latex: "pdf_tables_to_latex",
}

const operationArgsFromRequest = (request: PdfOperationRequest): JsonObject => {
  const args: JsonObject = {
    pages: request.pages as unknown as JsonObject["pages"],
  }
  if (request.fileId) args.fileId = request.fileId
  if (request.url) args.url = request.url
  if (request.base64) args.base64 = request.base64
  if (request.filename) args.filename = request.filename
  if (typeof request.renderScale === "number") args.renderScale = request.renderScale
  if (request.returnMode) args.returnMode = request.returnMode
  if (request.provider) args.provider = request.provider
  if (request.model) args.model = request.model
  if (request.prompt) args.prompt = request.prompt
  return args
}

const checkComputeAuth = (request: Request, env: Env, config: { service: { computeAuth?: { authHeader?: string; authEnv?: string } } }) =>
  checkHeaderAuth(request, env, {
    authHeader: config.service.computeAuth?.authHeader,
    authEnv: config.service.computeAuth?.authEnv,
    allowMissingSecret: false,
    misconfiguredCode: "COMPUTE_AUTH_MISCONFIGURED",
    unauthorizedCode: "UNAUTHORIZED",
    contextName: "compute endpoint",
  })

export default {
  async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const config = loadEchoPdfConfig(env)
    const runtimeStore = getRuntimeFileStore(env, config)
    const fileStore = runtimeStore.store

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: config.service.name, now: new Date().toISOString() })
    }

    if (request.method === "GET" && url.pathname === "/config") {
      return json({
        service: config.service,
        agent: config.agent,
        providers: Object.entries(config.providers).map(([alias, provider]) => ({ alias, type: provider.type })),
        capabilities: {
          toolCatalogEndpoint: "/tools/catalog",
          toolCallEndpoint: "/tools/call",
          fileOpsEndpoint: "/api/files/op",
          fileUploadEndpoint: "/api/files/upload",
          fileStatsEndpoint: "/api/files/stats",
          fileCleanupEndpoint: "/api/files/cleanup",
          supportedReturnModes: ["inline", "file_id", "url"],
        },
        mcp: {
          serverName: config.mcp.serverName,
          version: config.mcp.version,
          authHeader: config.mcp.authHeader ?? null,
        },
        fileGet: {
          authHeader: config.service.fileGet?.authHeader ?? null,
          cacheTtlSeconds: config.service.fileGet?.cacheTtlSeconds ?? 300,
        },
      })
    }

    if (request.method === "GET" && url.pathname === "/tools/catalog") {
      return json({ tools: listToolSchemas() })
    }

    if (request.method === "POST" && url.pathname === "/tools/call") {
      const auth = checkComputeAuth(request, env, config)
      if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status)
      const body = await readJson(request)
      const name = typeof body.name === "string" ? body.name : ""
      if (!name) return json({ error: "Missing required field: name" }, 400)
      try {
        const args = asObj(body.arguments)
        const preferredProvider = resolveProviderAlias(
          config,
          typeof body.provider === "string" ? body.provider : undefined
        )
        const preferredModel = resolveModelForProvider(
          config,
          preferredProvider,
          typeof body.model === "string" ? body.model : undefined
        )
        if (name === "pdf_ocr_pages" || name === "pdf_tables_to_latex") {
          if (typeof args.provider !== "string" || args.provider.length === 0) {
            args.provider = preferredProvider
          }
          if (typeof args.model !== "string" || args.model.length === 0) {
            args.model = preferredModel
          }
        }

        const result = await callTool(name, args, {
          config,
          env,
          fileStore,
          providerApiKeys: typeof body.providerApiKeys === "object" && body.providerApiKeys !== null
            ? (body.providerApiKeys as Record<string, string>)
            : undefined,
        })
        return json(buildToolOutputEnvelope(result, resolvePublicBaseUrl(request, config.service.publicBaseUrl)))
      } catch (error) {
        return jsonError(error, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/providers/models") {
      const auth = checkComputeAuth(request, env, config)
      if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status)
      const body = await readJson(request)
      const provider = resolveProviderAlias(config, typeof body.provider === "string" ? body.provider : undefined)
      const runtimeKeys = typeof body.providerApiKeys === "object" && body.providerApiKeys !== null
        ? (body.providerApiKeys as Record<string, string>)
        : undefined
      try {
        const models = await listProviderModels(config, env, provider, runtimeKeys)
        return json({ provider, models })
      } catch (error) {
        return jsonError(error, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run") {
      const auth = checkComputeAuth(request, env, config)
      if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status)
      const body = await readJson(request)
      if (Object.hasOwn(body, "operation") && !isValidOperation(body.operation)) {
        return json({ error: "Invalid operation. Must be one of: extract_pages, ocr_pages, tables_to_latex" }, 400)
      }
      const requestPayload = toPdfOperation(body, config.agent.defaultProvider)
      try {
        const result = await callTool(toolNameByOperation[requestPayload.operation], operationArgsFromRequest(requestPayload), {
          config,
          env,
          fileStore,
          providerApiKeys: requestPayload.providerApiKeys,
        })
        return json(result)
      } catch (error) {
        return jsonError(error, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/api/agent/stream") {
      const auth = checkComputeAuth(request, env, config)
      if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status)
      const body = await readJson(request)
      if (Object.hasOwn(body, "operation") && !isValidOperation(body.operation)) {
        return json({ error: "Invalid operation. Must be one of: extract_pages, ocr_pages, tables_to_latex" }, 400)
      }
      const requestPayload = toPdfOperation(body, config.agent.defaultProvider)
      const stream = new TransformStream<Uint8Array, Uint8Array>()
      const writer = stream.writable.getWriter()
      let queue: Promise<void> = Promise.resolve()
      const send = (event: string, data: unknown): void => {
        queue = queue.then(() => writer.write(encodeSse(event, data))).catch(() => undefined)
      }

      const run = async (): Promise<void> => {
        try {
          send("meta", { kind: "meta", startedAt: new Date().toISOString(), streaming: true })
          send("io", { kind: "io", direction: "input", content: requestPayload })

          const result = await callTool(toolNameByOperation[requestPayload.operation], operationArgsFromRequest(requestPayload), {
            config,
            env,
            fileStore,
            providerApiKeys: requestPayload.providerApiKeys,
            trace: (event: AgentTraceEvent) => send("step", event),
          })

          send("io", { kind: "io", direction: "output", content: "operation completed" })
          send("result", { kind: "result", output: result })
          send("done", { ok: true })
        } catch (error) {
          send("error", { kind: "error", message: toError(error) })
          send("done", { ok: false })
        } finally {
          await queue
          await writer.close()
        }
      }
      ctx.waitUntil(run())
      return sseResponse(stream.readable)
    }

    if (request.method === "POST" && url.pathname === "/api/files/op") {
      const body = await readJson(request)
      try {
        const result = await callTool("file_ops", asObj(body), {
          config,
          env,
          fileStore,
        })
        return json(result)
      } catch (error) {
        return jsonError(error, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/api/files/upload") {
      try {
        const formData = await request.formData()
        const file = formData.get("file") as {
          readonly name?: string
          readonly type?: string
          arrayBuffer?: () => Promise<ArrayBuffer>
        } | null
        if (!file || typeof file.arrayBuffer !== "function") {
          return json({ error: "Missing file field: file" }, 400)
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        const stored = await fileStore.put({
          filename: file.name || `upload-${Date.now()}.pdf`,
          mimeType: file.type || "application/pdf",
          bytes,
        })
        return json({ file: stored }, 200)
      } catch (error) {
        return jsonError(error, 500)
      }
    }

    if (request.method === "GET" && url.pathname === "/api/files/get") {
      const fileGetConfig = config.service.fileGet ?? {}
      const auth = checkHeaderAuth(request, env, {
        authHeader: fileGetConfig.authHeader,
        authEnv: fileGetConfig.authEnv,
        allowMissingSecret: env.ECHO_PDF_ALLOW_MISSING_AUTH_SECRET === "1",
        misconfiguredCode: "AUTH_MISCONFIGURED",
        unauthorizedCode: "UNAUTHORIZED",
        contextName: "file get",
      })
      if (!auth.ok) {
        return json({ error: auth.message, code: auth.code }, auth.status)
      }
      const fileId = url.searchParams.get("fileId") || ""
      if (!fileId) return json({ error: "Missing fileId" }, 400)
      const file = await fileStore.get(fileId)
      if (!file) return json({ error: "File not found" }, 404)
      const download = url.searchParams.get("download") === "1"
      const headers = new Headers()
      headers.set("Content-Type", file.mimeType)
      const cacheTtl = Number(fileGetConfig.cacheTtlSeconds ?? 300)
      const cacheControl = cacheTtl > 0
        ? `public, max-age=${Math.floor(cacheTtl)}, s-maxage=${Math.floor(cacheTtl)}`
        : "no-store"
      headers.set("Cache-Control", cacheControl)
      if (download) {
        headers.set("Content-Disposition", `attachment; filename=\"${sanitizeDownloadFilename(file.filename)}\"`)
      }
      return new Response(file.bytes, { status: 200, headers })
    }

    if (request.method === "GET" && url.pathname === "/api/files/stats") {
      try {
        return json(await runtimeStore.stats(), 200)
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/api/files/cleanup") {
      try {
        return json(await runtimeStore.cleanup(), 200)
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      return await handleMcpRequest(request, env, config, fileStore)
    }

    if (request.method === "GET" && env.ASSETS) {
      const assetReq = url.pathname === "/"
        ? new Request(new URL("/index.html", url), request)
        : request
      const asset = await env.ASSETS.fetch(assetReq)
      if (asset.status !== 404) return asset
    }

    return json(
      {
        error: "Not found",
        routes: {
          health: "GET /health",
          config: "GET /config",
          toolsCatalog: "GET /tools/catalog",
          toolCall: "POST /tools/call",
          models: "POST /providers/models",
          run: "POST /api/agent/run",
          stream: "POST /api/agent/stream",
          files: "POST /api/files/op",
          fileUpload: "POST /api/files/upload",
          fileGet: "GET /api/files/get?fileId=<id>",
          fileStats: "GET /api/files/stats",
          fileCleanup: "POST /api/files/cleanup",
          mcp: "POST /mcp",
        },
      },
      404
    )
  },
}

export { FileStoreDO }
