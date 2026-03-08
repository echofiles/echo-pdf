import fs from "node:fs"
import path from "node:path"

export const postJson = async (url, payload, extraHeaders = {}) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(data)}`)
  }
  return data
}

export const uploadFile = async (serviceUrl, filePath) => {
  const absPath = path.resolve(process.cwd(), filePath)
  const bytes = fs.readFileSync(absPath)
  const filename = path.basename(absPath)
  const form = new FormData()
  form.append("file", new Blob([bytes]), filename)
  const response = await fetch(`${serviceUrl}/api/files/upload`, { method: "POST", body: form })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(data)}`)
  }
  return data
}

export const downloadFile = async (serviceUrl, fileId, outputPath) => {
  const response = await fetch(`${serviceUrl}/api/files/get?fileId=${encodeURIComponent(fileId)}&download=1`)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status} ${text}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const absOut = path.resolve(process.cwd(), outputPath)
  fs.mkdirSync(path.dirname(absOut), { recursive: true })
  fs.writeFileSync(absOut, bytes)
  return absOut
}

export const withUploadedLocalFile = async (serviceUrl, tool, args) => {
  const nextArgs = { ...(args || {}) }
  if (tool.startsWith("pdf_")) {
    const localPath = typeof nextArgs.path === "string"
      ? nextArgs.path
      : (typeof nextArgs.filePath === "string" ? nextArgs.filePath : "")
    if (localPath && !nextArgs.fileId && !nextArgs.url && !nextArgs.base64) {
      const upload = await uploadFile(serviceUrl, localPath)
      const fileId = upload?.file?.id
      if (!fileId) throw new Error(`upload failed for local path: ${localPath}`)
      nextArgs.fileId = fileId
      delete nextArgs.path
      delete nextArgs.filePath
    }
  }
  return nextArgs
}
