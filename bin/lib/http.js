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

const parseAutoUploadFlag = (value) => {
  if (value === true) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
  }
  return false
}

export const prepareArgsWithLocalUploads = async (serviceUrl, tool, args, options = {}) => {
  const nextArgs = { ...(args || {}) }
  const uploads = []
  const autoUploadEnabled = options.autoUpload !== false
  if (tool.startsWith("pdf_")) {
    const localPath = typeof nextArgs.path === "string"
      ? nextArgs.path
      : (typeof nextArgs.filePath === "string" ? nextArgs.filePath : "")
    if (localPath && !nextArgs.fileId && !nextArgs.url && !nextArgs.base64) {
      if (!autoUploadEnabled) {
        throw new Error(
          "Local file auto-upload is disabled for `echo-pdf call`. " +
          "Use --auto-upload, or upload first (`echo-pdf file upload`) and pass fileId, or use `echo-pdf mcp-stdio`."
        )
      }
      const upload = await uploadFile(serviceUrl, localPath)
      const fileId = upload?.file?.id
      if (!fileId) throw new Error(`upload failed for local path: ${localPath}`)
      nextArgs.fileId = fileId
      delete nextArgs.path
      delete nextArgs.filePath
      uploads.push({ tool, localPath, fileId })
    }
  }
  return { args: nextArgs, uploads }
}

export const withUploadedLocalFile = async (serviceUrl, tool, args, options = {}) => {
  const { args: nextArgs } = await prepareArgsWithLocalUploads(serviceUrl, tool, args, {
    autoUpload: parseAutoUploadFlag(options.autoUpload ?? true),
  })
  return nextArgs
}
