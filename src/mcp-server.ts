import type { Env, FileStore } from "./types"
import type { EchoPdfConfig } from "./pdf-types"
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

const err = (id: JsonRpcRequest["id"], code: number, message: string): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  )

const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const maybeAuthorized = (request: Request, env: Env, config: EchoPdfConfig): boolean => {
  if (!config.mcp.authHeader || !config.mcp.authEnv) return true
  const required = env[config.mcp.authEnv]
  if (typeof required !== "string" || required.length === 0) return true
  return request.headers.get(config.mcp.authHeader) === required
}

export const handleMcpRequest = async (
  request: Request,
  env: Env,
  config: EchoPdfConfig,
  fileStore: FileStore
): Promise<Response> => {
  if (!maybeAuthorized(request, env, config)) {
    return new Response("Unauthorized", { status: 401 })
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
  const args = asObj(params.arguments)

  try {
    const result = await callTool(toolName, args, {
      config,
      env,
      fileStore,
    })
    return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }] })
  } catch (error) {
    return err(id, -32000, error instanceof Error ? error.message : String(error))
  }
}
