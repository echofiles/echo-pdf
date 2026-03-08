const els = {
  statusText: document.getElementById("statusText"),
  providerSelect: document.getElementById("providerSelect"),
  modelSelect: document.getElementById("modelSelect"),
  openaiModelInput: document.getElementById("openaiModelInput"),
  vercelModelInput: document.getElementById("vercelModelInput"),
  openrouterModelInput: document.getElementById("openrouterModelInput"),
  openaiKeyInput: document.getElementById("openaiKeyInput"),
  vercelKeyInput: document.getElementById("vercelKeyInput"),
  openrouterKeyInput: document.getElementById("openrouterKeyInput"),
  testModelsBtn: document.getElementById("testModelsBtn"),
  refreshToolsBtn: document.getElementById("refreshToolsBtn"),
  pdfUploadInput: document.getElementById("pdfUploadInput"),
  uploadPdfBtn: document.getElementById("uploadPdfBtn"),
  uploadedFileText: document.getElementById("uploadedFileText"),
  toolSelect: document.getElementById("toolSelect"),
  toolSourceText: document.getElementById("toolSourceText"),
  toolFields: document.getElementById("toolFields"),
  runToolBtn: document.getElementById("runToolBtn"),
  runStreamBtn: document.getElementById("runStreamBtn"),
  traceOutput: document.getElementById("traceOutput"),
  resultPreview: document.getElementById("resultPreview"),
  resultOutput: document.getElementById("resultOutput"),
}

const state = {
  config: null,
  tools: [],
  uploadedFileId: "",
  providerModels: {},
}

const MODEL_SETTINGS_KEY = "echo_pdf_provider_models"

const normalizeProviderModelMap = (input) => {
  const providers = state.config?.providers || []
  const validAliases = new Set(providers.map((p) => p.alias))
  const map = {}
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (!validAliases.has(k)) continue
      if (typeof v !== "string") continue
      map[k] = v.trim()
    }
  }
  return map
}

const loadProviderModelsFromStorage = () => {
  try {
    const raw = localStorage.getItem(MODEL_SETTINGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return normalizeProviderModelMap(parsed)
  } catch {
    return {}
  }
}

const configProviderModels = () => {
  const defaults = state.config?.agent?.defaultModels
  if (!defaults || typeof defaults !== "object") return {}
  return normalizeProviderModelMap(defaults)
}

const persistProviderModels = () => {
  localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(state.providerModels))
}

const setProviderModel = (provider, model) => {
  if (!provider) return
  state.providerModels[provider] = (model || "").trim()
  persistProviderModels()
}

const modelInputByProvider = (provider) => {
  if (provider === "openai") return els.openaiModelInput
  if (provider === "vercel_gateway") return els.vercelModelInput
  if (provider === "openrouter") return els.openrouterModelInput
  return null
}

const providerModelFromInput = (provider) => {
  const input = modelInputByProvider(provider)
  if (!input) return ""
  return input.value.trim()
}

const setStatus = (text) => {
  els.statusText.textContent = text
}

const appendTrace = (label, payload) => {
  els.traceOutput.textContent += `[${new Date().toLocaleTimeString()}] ${label}\n${JSON.stringify(payload, null, 2)}\n\n`
  els.traceOutput.scrollTop = els.traceOutput.scrollHeight
}

const clearResultPreview = () => {
  els.resultPreview.innerHTML = ""
}

const appendPreviewImage = (src, label) => {
  const card = document.createElement("article")
  card.className = "img-card"
  const meta = document.createElement("div")
  meta.className = "meta"
  meta.textContent = label
  const img = document.createElement("img")
  img.src = src
  img.alt = label
  card.append(meta, img)
  els.resultPreview.appendChild(card)
}

const renderResultPreview = (result) => {
  clearResultPreview()
  if (!result || typeof result !== "object") return

  if (typeof result.dataUrl === "string" && result.dataUrl.startsWith("data:image/")) {
    appendPreviewImage(result.dataUrl, "inline image")
  }

  if (Array.isArray(result.images)) {
    result.images.forEach((item, idx) => {
      if (item && typeof item.data === "string" && item.data.startsWith("data:image/")) {
        const pageText = Number.isFinite(item.page) ? `page ${item.page}` : `image ${idx + 1}`
        appendPreviewImage(item.data, pageText)
      }
    })
  }
}

const collectApiKeys = () => {
  const keys = {
    openai: els.openaiKeyInput.value.trim(),
    "vercel-ai-gateway": els.vercelKeyInput.value.trim(),
    openrouter: els.openrouterKeyInput.value.trim(),
  }
  if (!keys.openai && !keys["vercel-ai-gateway"] && !keys.openrouter) return undefined
  return keys
}

const fetchConfig = async () => {
  const res = await fetch("/config")
  if (!res.ok) throw new Error(`config failed: ${res.status}`)
  return res.json()
}

const loadModels = async () => {
  const provider = els.providerSelect.value
  setStatus(`Loading models from ${provider}...`)
  const res = await fetch("/providers/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, providerApiKeys: collectApiKeys() }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `models failed ${res.status}`)
  els.modelSelect.innerHTML = ""
  for (const model of data.models || []) {
    const option = document.createElement("option")
    option.value = model
    option.textContent = model
    els.modelSelect.appendChild(option)
  }
  const preferredModel = providerModelFromInput(provider)
  if (preferredModel) {
    const exists = Array.from(els.modelSelect.options).some((o) => o.value === preferredModel)
    if (!exists) {
      const option = document.createElement("option")
      option.value = preferredModel
      option.textContent = `${preferredModel} (manual)`
      els.modelSelect.prepend(option)
    }
    els.modelSelect.value = preferredModel
  }
  setStatus(`Loaded ${data.models.length} models`)
}

const fetchTools = async () => {
  const res = await fetch("/tools/catalog")
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `tools failed ${res.status}`)
  state.tools = Array.isArray(data.tools) ? data.tools : []
}

const defaultForSchema = (schema, key) => {
  if (!schema || typeof schema !== "object") return ""
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (schema.type === "boolean") return false
  if (schema.type === "number" || schema.type === "integer") return 1
  if (schema.type === "array") return key === "pages" ? "[1]" : "[]"
  if (schema.type === "object") return "{}"
  return ""
}

const renderToolFields = () => {
  const selected = state.tools.find((tool) => tool.name === els.toolSelect.value)
  els.toolFields.innerHTML = ""
  if (!selected) return

  const sourceText = `${selected.source?.kind ?? "local"}:${selected.source?.toolName ?? "unknown"}`
  els.toolSourceText.textContent = `${sourceText} | ${selected.description}`

  const properties = selected.inputSchema?.properties ?? {}
  for (const [key, schema] of Object.entries(properties)) {
    const field = document.createElement("div")
    field.className = "field"
    const type = schema?.type ?? "string"
    const defaultValue = defaultForSchema(schema, key)

    if (Array.isArray(schema?.enum)) {
      field.innerHTML = `<label>${key}</label><select data-key="${key}">${schema.enum
        .map((item) => `<option value="${item}">${item}</option>`)
        .join("")}</select>`
      els.toolFields.appendChild(field)
      continue
    }

    if (type === "boolean") {
      field.innerHTML = `<label><input data-key="${key}" type="checkbox" ${defaultValue ? "checked" : ""}/> ${key}</label>`
      els.toolFields.appendChild(field)
      continue
    }

    if (type === "array" || type === "object") {
      field.innerHTML = `<label>${key}</label><textarea data-key="${key}" rows="3">${defaultValue}</textarea>`
      els.toolFields.appendChild(field)
      continue
    }

    field.innerHTML = `<label>${key}</label><input data-key="${key}" type="text" value="${defaultValue}"/>`
    els.toolFields.appendChild(field)
  }

  if (state.uploadedFileId) {
    const fileIdInput = els.toolFields.querySelector("[data-key='fileId']")
    if (fileIdInput) {
      fileIdInput.value = state.uploadedFileId
    }
  }
}

const renderTools = () => {
  els.toolSelect.innerHTML = ""
  for (const tool of state.tools) {
    const option = document.createElement("option")
    option.value = tool.name
    option.textContent = tool.name
    els.toolSelect.appendChild(option)
  }
  renderToolFields()
}

const readToolArguments = () => {
  const selected = state.tools.find((tool) => tool.name === els.toolSelect.value)
  if (!selected) return {}
  const properties = selected.inputSchema?.properties ?? {}
  const args = {}
  for (const [key, schema] of Object.entries(properties)) {
    const input = els.toolFields.querySelector(`[data-key='${key}']`)
    if (!input) continue

    if (schema?.type === "boolean") {
      args[key] = input.checked
      continue
    }

    const raw = String(input.value ?? "").trim()
    if (raw.length === 0) continue

    if (schema?.type === "number" || schema?.type === "integer") {
      args[key] = Number(raw)
      continue
    }

    if (schema?.type === "array" || schema?.type === "object") {
      try {
        args[key] = JSON.parse(raw)
      } catch {
        throw new Error(`Field ${key} must be valid JSON`)
      }
      continue
    }

    args[key] = raw
  }

  if (selected.name.startsWith("pdf_") && !args.fileId && state.uploadedFileId) {
    args.fileId = state.uploadedFileId
  }
  if (selected.name.startsWith("pdf_") && (!Array.isArray(args.pages) || args.pages.length === 0)) {
    throw new Error("pages is required, e.g. [1] or [1,2]")
  }

  return args
}

const uploadPdf = async () => {
  const file = els.pdfUploadInput.files?.[0]
  if (!file) {
    throw new Error("Please select a PDF file first")
  }
  const formData = new FormData()
  formData.set("file", file)
  const res = await fetch("/api/files/upload", {
    method: "POST",
    body: formData,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `upload failed: ${res.status}`)
  const fileId = data.file?.id
  if (!fileId) throw new Error("Upload succeeded but no fileId returned")
  state.uploadedFileId = fileId
  els.uploadedFileText.textContent = `uploaded fileId: ${fileId} (${data.file.filename})`
  renderToolFields()
  appendTrace("file.upload", { file: data.file })
}

const runTool = async () => {
  const name = els.toolSelect.value
  const argumentsPayload = readToolArguments()
  const provider = els.providerSelect.value
  const model = els.modelSelect.value || providerModelFromInput(provider)
  const res = await fetch("/tools/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      arguments: argumentsPayload,
      provider,
      model,
      providerApiKeys: collectApiKeys(),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `tool failed: ${res.status}`)
  renderResultPreview(data.output)
  els.resultOutput.textContent = JSON.stringify(data.output, null, 2)
  appendTrace("tool.result", { name, arguments: argumentsPayload })
}

const runStream = async () => {
  const name = els.toolSelect.value
  const args = readToolArguments()
  const operationMap = {
    pdf_extract_pages: "extract_pages",
    pdf_ocr_pages: "ocr_pages",
    pdf_tables_to_latex: "tables_to_latex",
  }
  const op = operationMap[name]
  if (!op) throw new Error("stream mode supports only pdf_* tools")

  const provider = els.providerSelect.value
  const model = els.modelSelect.value || providerModelFromInput(provider)
  const payload = {
    operation: op,
    ...args,
    provider,
    model,
    providerApiKeys: collectApiKeys(),
  }

  els.traceOutput.textContent = ""
  clearResultPreview()
  els.resultOutput.textContent = ""
  const res = await fetch("/api/agent/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `stream failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let idx = buffer.indexOf("\n\n")
    while (idx !== -1) {
      const raw = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 2)
      idx = buffer.indexOf("\n\n")
      if (!raw) continue
      const lines = raw.split("\n")
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || "message"
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim() || "{}"
      const data = JSON.parse(dataLine)
      if (event === "result") {
        const output = data.output ?? data
        renderResultPreview(output)
        els.resultOutput.textContent = JSON.stringify(output, null, 2)
      } else {
        appendTrace(event, data)
      }
    }
  }
}

const init = async () => {
  setStatus("Loading config...")
  state.config = await fetchConfig()

  const providers = state.config.providers || []
  els.providerSelect.innerHTML = ""
  for (const p of providers) {
    const option = document.createElement("option")
    option.value = p.alias
    option.textContent = `${p.alias} (${p.type})`
    els.providerSelect.appendChild(option)
  }

  if (providers.length > 0) {
    els.providerSelect.value = state.config.agent.defaultProvider || providers[0].alias
    state.providerModels = { ...configProviderModels(), ...loadProviderModelsFromStorage() }
    els.openaiModelInput.value = state.providerModels.openai || ""
    els.vercelModelInput.value = state.providerModels.vercel_gateway || ""
    els.openrouterModelInput.value = state.providerModels.openrouter || ""
    await loadModels()
  }

  await fetchTools()
  renderTools()
  setStatus("Ready")
}

els.providerSelect.addEventListener("change", () => void loadModels())
els.modelSelect.addEventListener("change", () => {
  const provider = els.providerSelect.value
  const model = els.modelSelect.value.trim()
  setProviderModel(provider, model)
  const input = modelInputByProvider(provider)
  if (input) input.value = model
})
els.openaiModelInput.addEventListener("change", () => {
  const model = els.openaiModelInput.value.trim()
  setProviderModel("openai", model)
  if (els.providerSelect.value === "openai") {
    void loadModels().catch(() => undefined)
  }
})
els.vercelModelInput.addEventListener("change", () => {
  const model = els.vercelModelInput.value.trim()
  setProviderModel("vercel_gateway", model)
  if (els.providerSelect.value === "vercel_gateway") {
    void loadModels().catch(() => undefined)
  }
})
els.openrouterModelInput.addEventListener("change", () => {
  const model = els.openrouterModelInput.value.trim()
  setProviderModel("openrouter", model)
  if (els.providerSelect.value === "openrouter") {
    void loadModels().catch(() => undefined)
  }
})
els.testModelsBtn.addEventListener("click", async () => {
  try {
    await loadModels()
  } catch (error) {
    appendTrace("models.error", { message: String(error) })
    setStatus("Model load failed")
  }
})
els.refreshToolsBtn.addEventListener("click", async () => {
  try {
    await fetchTools()
    renderTools()
    setStatus("Tools refreshed")
  } catch (error) {
    appendTrace("tools.error", { message: String(error) })
    setStatus("Tool refresh failed")
  }
})
els.uploadPdfBtn.addEventListener("click", async () => {
  try {
    setStatus("Uploading PDF...")
    await uploadPdf()
    setStatus("Upload completed")
  } catch (error) {
    appendTrace("upload.error", { message: String(error) })
    setStatus("Upload failed")
  }
})
els.toolSelect.addEventListener("change", renderToolFields)
els.runToolBtn.addEventListener("click", async () => {
  try {
    setStatus("Running tool...")
    await runTool()
    setStatus("Completed")
  } catch (error) {
    appendTrace("tool.error", { message: String(error) })
    setStatus("Failed")
  }
})
els.runStreamBtn.addEventListener("click", async () => {
  try {
    setStatus("Running stream...")
    await runStream()
    setStatus("Completed")
  } catch (error) {
    appendTrace("stream.error", { message: String(error) })
    setStatus("Failed")
  }
})

void init().catch((error) => {
  setStatus("Init failed")
  appendTrace("init.error", { message: String(error) })
})
