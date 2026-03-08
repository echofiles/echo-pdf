import type { Env, FileStore } from "./types"
import type { EchoPdfConfig } from "./pdf-types"
import { buildMcpContent, buildToolOutputEnvelope } from "./response-schema"
import { callTool, listToolSchemas } from "./tool-registry"

interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
}

const ok = (id: JsonRpcRequest["id"], result: unknown): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      result,
    }),
    { headers: { "Content-Type": "application/json" } }
  )

const err = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: Record<string, unknown>
): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: data ? { code, message, data } : { code, message },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  )

const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const authState = (
  request: Request,
  env: Env,
  config: EchoPdfConfig
): { ok: true } | { ok: false; status: number; message: string } => {
  if (!config.mcp.authHeader || !config.mcp.authEnv) return { ok: true }
  const required = env[config.mcp.authEnv]
  if (typeof required !== "string" || required.length === 0) {
    return { ok: false, status: 500, message: `MCP auth is configured but env "${config.mcp.authEnv}" is missing` }
  }
  if (request.headers.get(config.mcp.authHeader) !== required) {
    return { ok: false, status: 401, message: "Unauthorized" }
  }
  return { ok: true }
}

const resolvePublicBaseUrl = (request: Request, configured?: string): string =>
  typeof configured === "string" && configured.length > 0 ? configured : request.url

const prepareMcpToolArgs = (toolName: string, args: Record<string, unknown>): Record<string, unknown> => {
  if (toolName === "pdf_extract_pages") {
    const mode = typeof args.returnMode === "string" ? args.returnMode : ""
    if (!mode) {
      return { ...args, returnMode: "url" }
    }
  }
  return args
}

export const handleMcpRequest = async (
  request: Request,
  env: Env,
  config: EchoPdfConfig,
  fileStore: FileStore
): Promise<Response> => {
  const auth = authState(request, env, config)
  if (!auth.ok) {
    return new Response(auth.message, { status: auth.status })
  }

  let body: JsonRpcRequest
  try {
    body = (await request.json()) as JsonRpcRequest
  } catch {
    return err(null, -32700, "Parse error")
  }
  if (typeof body !== "object" || body === null) {
    return err(null, -32600, "Invalid Request")
  }
  if (body.jsonrpc !== "2.0") {
    return err(body.id ?? null, -32600, "Invalid Request: jsonrpc must be '2.0'")
  }
  const method = body.method ?? ""
  const id = body.id ?? null
  if (typeof method !== "string" || method.length === 0) {
    return err(id, -32600, "Invalid Request: method is required")
  }
  if (method.startsWith("notifications/")) {
    return new Response(null, { status: 204 })
  }
  const params = asObj(body.params)

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: config.mcp.serverName,
        version: config.mcp.version,
      },
      capabilities: {
        tools: {},
      },
    })
  }

  if (method === "tools/list") {
    return ok(id, { tools: listToolSchemas().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })) })
  }

  if (method !== "tools/call") {
    return err(id, -32601, `Unsupported method: ${method}`)
  }

  const toolName = typeof params.name === "string" ? params.name : ""
  const args = prepareMcpToolArgs(toolName, asObj(params.arguments))
  if (!toolName) {
    return err(id, -32602, "Invalid params: name is required", {
      code: "INVALID_PARAMS",
      status: 400,
    })
  }

  try {
    const result = await callTool(toolName, args, {
      config,
      env,
      fileStore,
    })
    const envelope = buildToolOutputEnvelope(result, resolvePublicBaseUrl(request, config.service.publicBaseUrl))
    return ok(id, { content: buildMcpContent(envelope) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = (error as { status?: unknown })?.status
    const stableStatus = typeof status === "number" && Number.isFinite(status) ? status : 500
    const code = (error as { code?: unknown })?.code
    const details = (error as { details?: unknown })?.details
    if (message.startsWith("Unknown tool:")) {
      return err(id, -32601, message, {
        code: typeof code === "string" ? code : "TOOL_NOT_FOUND",
        status: 404,
        details,
      })
    }
    if (stableStatus >= 400 && stableStatus < 500) {
      return err(id, -32602, message, {
        code: typeof code === "string" ? code : "INVALID_PARAMS",
        status: stableStatus,
        details,
      })
    }
    return err(id, -32000, message, {
      code: typeof code === "string" ? code : "INTERNAL_ERROR",
      status: stableStatus,
      details,
    })
  }
}
