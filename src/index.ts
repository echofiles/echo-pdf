import { normalizeReturnMode } from "./file-utils"
import { handleMcpRequest } from "./mcp-server"
import { loadEchoPdfConfig } from "./pdf-config"
import { runtimeFileStore } from "./pdf-storage"
import { listProviderModels } from "./provider-client"
import { callTool, listToolSchemas } from "./tool-registry"
import type { AgentTraceEvent, PdfOperationRequest } from "./pdf-types"
import type { Env, JsonObject } from "./types"

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

const toPdfOperation = (input: Record<string, unknown>, defaultProvider: string): PdfOperationRequest => ({
  operation: (input.operation as "extract_pages" | "ocr_pages" | "tables_to_latex") ?? "extract_pages",
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const config = loadEchoPdfConfig(env)

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
          supportedReturnModes: ["inline", "file_id", "url"],
        },
        mcp: {
          serverName: config.mcp.serverName,
          version: config.mcp.version,
          authHeader: config.mcp.authHeader ?? null,
        },
      })
    }

    if (request.method === "GET" && url.pathname === "/tools/catalog") {
      return json({ tools: listToolSchemas() })
    }

    if (request.method === "POST" && url.pathname === "/tools/call") {
      const body = await readJson(request)
      const name = typeof body.name === "string" ? body.name : ""
      if (!name) return json({ error: "Missing required field: name" }, 400)
      try {
        const result = await callTool(name, body.arguments, {
          config,
          env,
          fileStore: runtimeFileStore,
          providerApiKeys: typeof body.providerApiKeys === "object" && body.providerApiKeys !== null
            ? (body.providerApiKeys as Record<string, string>)
            : undefined,
        })
        return json({ name, output: result })
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/providers/models") {
      const body = await readJson(request)
      const provider = typeof body.provider === "string" ? body.provider : config.agent.defaultProvider
      const runtimeKeys = typeof body.providerApiKeys === "object" && body.providerApiKeys !== null
        ? (body.providerApiKeys as Record<string, string>)
        : undefined
      try {
        const models = await listProviderModels(config, env, provider, runtimeKeys)
        return json({ provider, models })
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run") {
      const body = await readJson(request)
      const requestPayload = toPdfOperation(body, config.agent.defaultProvider)
      try {
        const result = await callTool(toolNameByOperation[requestPayload.operation], operationArgsFromRequest(requestPayload), {
          config,
          env,
          fileStore: runtimeFileStore,
          providerApiKeys: requestPayload.providerApiKeys,
        })
        return json(result)
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/api/agent/stream") {
      const body = await readJson(request)
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
            fileStore: runtimeFileStore,
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
          fileStore: runtimeFileStore,
        })
        return json(result)
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        return await handleMcpRequest(request, env, config, runtimeFileStore)
      } catch (error) {
        return json({ error: toError(error) }, 500)
      }
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
          mcp: "POST /mcp",
        },
      },
      404
    )
  },
}
