const mcpReadLoop = (onMessage, onError) => {
  let buffer = Buffer.alloc(0)
  let expectedLength = null
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      if (expectedLength === null) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd === -1) break
        const headerRaw = buffer.slice(0, headerEnd).toString("utf-8")
        const lines = headerRaw.split("\r\n")
        const cl = lines.find((line) => line.toLowerCase().startsWith("content-length:"))
        if (!cl) {
          onError(new Error("Missing Content-Length"))
          buffer = buffer.slice(headerEnd + 4)
          continue
        }
        expectedLength = Number(cl.split(":")[1]?.trim() || "0")
        buffer = buffer.slice(headerEnd + 4)
      }
      if (!Number.isFinite(expectedLength) || expectedLength < 0) {
        onError(new Error("Invalid Content-Length"))
        expectedLength = null
        continue
      }
      if (buffer.length < expectedLength) break
      const body = buffer.slice(0, expectedLength).toString("utf-8")
      buffer = buffer.slice(expectedLength)
      expectedLength = null
      try {
        const maybePromise = onMessage(JSON.parse(body))
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch(onError)
        }
      } catch (error) {
        onError(error)
      }
    }
  })
}

const mcpWrite = (obj) => {
  const body = Buffer.from(JSON.stringify(obj))
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(header)
  process.stdout.write(body)
}

export const runMcpStdio = async (deps) => {
  const {
    serviceUrl,
    headers,
    postJson,
    withUploadedLocalFile,
  } = deps
  mcpReadLoop(async (msg) => {
    const method = msg?.method
    const id = Object.hasOwn(msg || {}, "id") ? msg.id : null
    if (msg?.jsonrpc !== "2.0" || typeof method !== "string") {
      mcpWrite({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } })
      return
    }
    if (method === "notifications/initialized") return
    if (method === "initialize" || method === "tools/list") {
      const data = await postJson(`${serviceUrl}/mcp`, msg, headers)
      mcpWrite(data)
      return
    }
    if (method === "tools/call") {
      try {
        const tool = String(msg?.params?.name || "")
        const args = (msg?.params?.arguments && typeof msg.params.arguments === "object")
          ? msg.params.arguments
          : {}
        const preparedArgs = await withUploadedLocalFile(serviceUrl, tool, args)
        const payload = {
          ...msg,
          params: {
            ...(msg.params || {}),
            arguments: preparedArgs,
          },
        }
        const data = await postJson(`${serviceUrl}/mcp`, payload, headers)
        mcpWrite(data)
      } catch (error) {
        mcpWrite({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        })
      }
      return
    }
    const data = await postJson(`${serviceUrl}/mcp`, msg, headers)
    mcpWrite(data)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  })
}
