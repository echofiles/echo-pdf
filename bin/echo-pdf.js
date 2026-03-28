#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { downloadFile, postJson, prepareArgsWithLocalUploads, uploadFile, withUploadedLocalFile } from "./lib/http.js"
import { runMcpStdio } from "./lib/mcp-stdio.js"

const CONFIG_DIR = path.join(os.homedir(), ".config", "echo-pdf-cli")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_CONFIG_FILE = path.resolve(__dirname, "../echo-pdf.config.json")
const PROJECT_CONFIG = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, "utf-8"))
const PROVIDER_ENTRIES = Object.entries(PROJECT_CONFIG.providers || {})
const PROVIDER_ALIASES = PROVIDER_ENTRIES.map(([alias]) => alias)
const PROVIDER_ALIAS_BY_TYPE = new Map(
  PROVIDER_ENTRIES.map(([alias, provider]) => [provider.type, alias])
)
const PROVIDER_SET_NAMES = Array.from(
  new Set(PROVIDER_ENTRIES.flatMap(([alias, provider]) => [alias, provider.type]))
)
const PROJECT_DEFAULT_MODEL = String(PROJECT_CONFIG.agent?.defaultModel || "").trim()
const DEFAULT_WORKER_NAME = process.env.ECHO_PDF_WORKER_NAME || PROJECT_CONFIG.service?.name || "echo-pdf"
const DEFAULT_SERVICE_URL = process.env.ECHO_PDF_SERVICE_URL || `https://${DEFAULT_WORKER_NAME}.echofilesai.workers.dev`
const DEFAULT_MCP_HEADER = process.env.ECHO_PDF_MCP_HEADER?.trim() || PROJECT_CONFIG.mcp?.authHeader || "x-mcp-key"

const emptyProviders = () =>
  Object.fromEntries(PROVIDER_ALIASES.map((providerAlias) => [providerAlias, { apiKey: "" }]))

const resolveProviderAliasInput = (input) => {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("provider is required")
  }
  const raw = input.trim()
  if (PROVIDER_ALIASES.includes(raw)) return raw
  const fromType = PROVIDER_ALIAS_BY_TYPE.get(raw)
  if (fromType) return fromType
  throw new Error(`provider must be one of: ${PROVIDER_SET_NAMES.join(", ")}`)
}

function resolveDefaultProviderAlias() {
  const configured = PROJECT_CONFIG.agent?.defaultProvider
  if (typeof configured === "string" && configured.trim().length > 0) {
    return resolveProviderAliasInput(configured.trim())
  }
  return PROVIDER_ALIASES[0] || "openai"
}

const DEFAULT_PROVIDER_ALIAS = resolveDefaultProviderAlias()

const defaultConfig = () => ({
  serviceUrl: DEFAULT_SERVICE_URL,
  profile: "default",
  profiles: {
    default: {
      defaultProvider: DEFAULT_PROVIDER_ALIAS,
      models: {},
      providers: emptyProviders(),
    },
  },
})

const ensureConfig = () => {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2))
  }
}

const loadConfig = () => {
  ensureConfig()
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
  if (!config.profiles || typeof config.profiles !== "object") {
    config.profiles = {}
  }
  if (typeof config.profile !== "string" || !config.profile) {
    config.profile = "default"
  }
  const profile = getProfile(config, config.profile)
  if (typeof profile.defaultProvider !== "string" || !profile.defaultProvider) {
    profile.defaultProvider = DEFAULT_PROVIDER_ALIAS
  }
  if (!profile.providers || typeof profile.providers !== "object") {
    profile.providers = emptyProviders()
  }
  for (const providerAlias of PROVIDER_ALIASES) {
    if (!profile.providers[providerAlias] || typeof profile.providers[providerAlias] !== "object") {
      profile.providers[providerAlias] = { apiKey: "" }
    }
  }
  if (!profile.models || typeof profile.models !== "object") {
    profile.models = {}
  }
  saveConfig(config)
  return config
}

const saveConfig = (config) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

const parseFlags = (args) => {
  const flags = {}
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token?.startsWith("--")) continue
    const key = token.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
    } else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

const getProfile = (config, name) => {
  const profileName = name || config.profile || "default"
  if (!config.profiles[profileName]) {
    config.profiles[profileName] = {
      defaultProvider: DEFAULT_PROVIDER_ALIAS,
      models: {},
      providers: {},
    }
  }
  const profile = config.profiles[profileName]
  if (!profile.providers || typeof profile.providers !== "object") profile.providers = {}
  for (const providerAlias of PROVIDER_ALIASES) {
    if (!profile.providers[providerAlias] || typeof profile.providers[providerAlias] !== "object") {
      profile.providers[providerAlias] = { apiKey: "" }
    }
  }
  if (!profile.models || typeof profile.models !== "object") profile.models = {}
  if (typeof profile.defaultProvider !== "string" || !profile.defaultProvider) {
    profile.defaultProvider = DEFAULT_PROVIDER_ALIAS
  }
  return profile
}

const getProfileName = (config, profileName) => profileName || config.profile || "default"

const resolveProviderAlias = (profile, explicitProvider) =>
  typeof explicitProvider === "string" && explicitProvider.length > 0
    ? resolveProviderAliasInput(explicitProvider)
    : resolveProviderAliasInput(profile.defaultProvider || DEFAULT_PROVIDER_ALIAS)

const resolveDefaultModel = (profile, providerAlias) => {
  const model = profile.models?.[providerAlias]
  if (typeof model === "string" && model.trim().length > 0) return model.trim()
  return PROJECT_DEFAULT_MODEL
}

const buildProviderApiKeys = (config, profileName) => {
  const profile = getProfile(config, profileName)
  const providerApiKeys = {}
  for (const [providerAlias, providerConfig] of PROVIDER_ENTRIES) {
    const apiKey = profile.providers?.[providerAlias]?.apiKey || profile.providers?.[providerConfig.type]?.apiKey || ""
    providerApiKeys[providerAlias] = apiKey
    providerApiKeys[providerConfig.type] = apiKey
  }
  return providerApiKeys
}

const print = (data) => {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

const buildMcpHeaders = () => {
  const token = process.env.ECHO_PDF_MCP_KEY?.trim()
  if (!token) return {}
  return { [DEFAULT_MCP_HEADER]: token }
}

const buildModelsRequest = (provider, providerApiKeys) => ({ provider, providerApiKeys })

const buildToolCallRequest = (input) => ({
  name: input.tool,
  arguments: input.args,
  provider: input.provider,
  model: input.model,
  providerApiKeys: input.providerApiKeys,
})

const buildMcpRequest = (id, method, params = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
})

const runDevServer = (port, host) => {
  const wranglerBin = path.resolve(__dirname, "../node_modules/.bin/wrangler")
  const wranglerArgs = ["dev", "--port", String(port), "--ip", host]
  const cmd = fs.existsSync(wranglerBin) ? wranglerBin : "npx"
  const args = fs.existsSync(wranglerBin) ? wranglerArgs : ["-y", "wrangler", ...wranglerArgs]
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  })
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(code ?? 0)
  })
}

const printLocalServiceHints = (host, port) => {
  const resolvedHost = host === "0.0.0.0" ? "127.0.0.1" : host
  const baseUrl = `http://${resolvedHost}:${port}`
  const mcpUrl = `${baseUrl}/mcp`
  process.stdout.write(`\nLocal component endpoints:\n`)
  process.stdout.write(`  ECHO_PDF_BASE_URL=${baseUrl}\n`)
  process.stdout.write(`  ECHO_PDF_MCP_URL=${mcpUrl}\n`)
  process.stdout.write(`\nExport snippet:\n`)
  process.stdout.write(`  export ECHO_PDF_BASE_URL=${baseUrl}\n`)
  process.stdout.write(`  export ECHO_PDF_MCP_URL=${mcpUrl}\n\n`)
}

const runMcpStdioCommand = async (serviceUrlOverride) => {
  const config = loadConfig()
  const serviceUrl = typeof serviceUrlOverride === "string" && serviceUrlOverride.trim().length > 0
    ? serviceUrlOverride.trim()
    : config.serviceUrl
  await runMcpStdio({
    serviceUrl,
    headers: buildMcpHeaders(),
    postJson,
    withUploadedLocalFile,
  })
}

const parseConfigValue = (raw, type = "auto") => {
  if (type === "string") return String(raw)
  if (type === "number") {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`Invalid number: ${raw}`)
    return n
  }
  if (type === "boolean") {
    if (raw === "true") return true
    if (raw === "false") return false
    throw new Error(`Invalid boolean: ${raw}`)
  }
  if (type === "json") {
    return JSON.parse(raw)
  }
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

const hasPath = (obj, dottedPath) => {
  const parts = dottedPath.split(".").filter(Boolean)
  let cur = obj
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return false
    cur = cur[part]
  }
  return true
}

const setPath = (obj, dottedPath, value) => {
  const parts = dottedPath.split(".").filter(Boolean)
  if (parts.length === 0) throw new Error("config key is required")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]
    if (!cur[part] || typeof cur[part] !== "object" || Array.isArray(cur[part])) {
      cur[part] = {}
    }
    cur = cur[part]
  }
  cur[parts[parts.length - 1]] = value
}

const readDevVarsConfigJson = (devVarsPath) => {
  if (!fs.existsSync(devVarsPath)) return null
  const lines = fs.readFileSync(devVarsPath, "utf-8").split(/\r?\n/)
  for (const line of lines) {
    if (line.startsWith("ECHO_PDF_CONFIG_JSON=")) {
      const raw = line.slice("ECHO_PDF_CONFIG_JSON=".length).trim()
      if (!raw) return null
      return JSON.parse(raw)
    }
  }
  return null
}

const writeDevVarsConfigJson = (devVarsPath, configJson) => {
  const serialized = JSON.stringify(configJson)
  const nextLine = `ECHO_PDF_CONFIG_JSON=${serialized}`
  let lines = []
  if (fs.existsSync(devVarsPath)) {
    lines = fs.readFileSync(devVarsPath, "utf-8").split(/\r?\n/)
    let replaced = false
    lines = lines.map((line) => {
      if (line.startsWith("ECHO_PDF_CONFIG_JSON=")) {
        replaced = true
        return nextLine
      }
      return line
    })
    if (!replaced) {
      if (lines.length > 0 && lines[lines.length - 1].trim().length !== 0) lines.push("")
      lines.push(nextLine)
    }
  } else {
    lines = [nextLine]
  }
  fs.writeFileSync(devVarsPath, lines.join("\n"))
}

const LOCAL_DOCUMENT_DIST_ENTRY = new URL("../dist/local/index.js", import.meta.url)
const LOCAL_DOCUMENT_SOURCE_ENTRY = new URL("../src/local/index.ts", import.meta.url)
const IS_BUN_RUNTIME = typeof process.versions?.bun === "string"

const loadLocalDocumentApi = async () => {
  try {
    return await import(LOCAL_DOCUMENT_DIST_ENTRY.href)
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : ""
    if (
      code === "ERR_MODULE_NOT_FOUND" &&
      IS_BUN_RUNTIME &&
      fs.existsSync(fileURLToPath(LOCAL_DOCUMENT_SOURCE_ENTRY))
    ) {
      return import(LOCAL_DOCUMENT_SOURCE_ENTRY.href)
    }
    if (code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "Local document commands require built artifacts in a source checkout. " +
        "Run `npm run build` first, use `npm run document:dev -- <subcommand> ...` in a source checkout, or install the published package."
      )
    }
    throw error
  }
}

const usage = () => {
  process.stdout.write(`echo-pdf CLI\n\n`)
  process.stdout.write(`Commands:\n`)
  process.stdout.write(`  init [--service-url URL]\n`)
  process.stdout.write(`  dev [--port 8788] [--host 127.0.0.1]\n`)
  process.stdout.write(`  provider set --provider <${PROVIDER_SET_NAMES.join("|")}> --api-key <KEY> [--profile name]\n`)
  process.stdout.write(`  provider use --provider <${PROVIDER_ALIASES.join("|")}> [--profile name]\n`)
  process.stdout.write(`  provider list [--profile name]\n`)
  process.stdout.write(`  models [--provider alias] [--profile name]\n`)
  process.stdout.write(`  config set --key <dotted.path> --value <value> [--type auto|string|number|boolean|json] [--dev-vars .dev.vars]\n`)
  process.stdout.write(`  model set --model <model-id> [--provider alias] [--profile name]\n`)
  process.stdout.write(`  model get [--provider alias] [--profile name]\n`)
  process.stdout.write(`  model list [--profile name]\n`)
  process.stdout.write(`  tools\n`)
  process.stdout.write(`  call --tool <name> --args '<json>' [--provider alias] [--model model] [--profile name] [--auto-upload]\n`)
  process.stdout.write(`  document index <file.pdf> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  document get <file.pdf> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  document structure <file.pdf> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  document page <file.pdf> --page <N> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  document render <file.pdf> --page <N> [--scale N] [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  document ocr <file.pdf> --page <N> [--scale N] [--provider alias] [--model model] [--prompt text] [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  file upload <local.pdf>\n`)
  process.stdout.write(`  file get --file-id <id> --out <path>\n`)
  process.stdout.write(`  mcp initialize\n`)
  process.stdout.write(`  mcp tools\n`)
  process.stdout.write(`  mcp call --tool <name> --args '<json>'\n`)
  process.stdout.write(`  mcp-stdio [--service-url URL]\n`)
  process.stdout.write(`  mcp stdio\n`)
  process.stdout.write(`  setup add <claude-desktop|claude-code|cursor|cline|windsurf|gemini|json>\n`)
}

const setupSnippet = (tool, serviceUrl, mode = "http") => {
  if (mode === "stdio") {
    return {
      mcpServers: {
        "echo-pdf": {
          command: "echo-pdf",
          args: ["mcp-stdio"],
          env: {
            ECHO_PDF_SERVICE_URL: serviceUrl,
          },
        },
      },
    }
  }
  const transport = {
    type: "streamable-http",
    url: `${serviceUrl}/mcp`,
  }
  if (tool === "json") {
    return {
      mcpServers: {
        "echo-pdf": transport,
      },
    }
  }
  if (tool === "claude-desktop") {
    return {
      file: "claude_desktop_config.json",
      snippet: {
        mcpServers: {
          "echo-pdf": transport,
        },
      },
    }
  }
  if (tool === "cursor") {
    return {
      file: "~/.cursor/mcp.json",
      snippet: {
        mcpServers: {
          "echo-pdf": transport,
        },
      },
    }
  }
  if (tool === "cline") {
    return {
      file: "~/.cline/mcp_settings.json",
      snippet: {
        mcpServers: {
          "echo-pdf": transport,
        },
      },
    }
  }
  if (tool === "windsurf") {
    return {
      file: "~/.codeium/windsurf/mcp_config.json",
      snippet: {
        mcpServers: {
          "echo-pdf": transport,
        },
      },
    }
  }
  if (tool === "claude-code" || tool === "gemini") {
    return {
      note: "If your tool does not support streamable-http directly, use an HTTP-to-stdio MCP bridge (for example mcp-remote) and point it to /mcp.",
      url: `${serviceUrl}/mcp`,
    }
  }
  throw new Error(`Unsupported tool: ${tool}`)
}

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage()
    return
  }

  const [command, ...raw] = argv
  let subcommand = ""
  let rest = raw
  if (["provider", "mcp", "setup", "model", "config", "document"].includes(command)) {
    subcommand = raw[0] || ""
    rest = raw.slice(1)
  }
  const flags = parseFlags(rest)

  if (command === "init") {
    const config = loadConfig()
    if (typeof flags["service-url"] === "string") {
      config.serviceUrl = flags["service-url"]
      saveConfig(config)
    }
    print({ ok: true, configFile: CONFIG_FILE, serviceUrl: config.serviceUrl })
    return
  }

  if (command === "dev") {
    const port = typeof flags.port === "string" ? Number(flags.port) : 8788
    const host = typeof flags.host === "string" ? flags.host : "127.0.0.1"
    if (!Number.isFinite(port) || port <= 0) throw new Error("dev --port must be positive number")
    printLocalServiceHints(host, Math.floor(port))
    runDevServer(Math.floor(port), host)
    return
  }

  if (command === "mcp-stdio") {
    await runMcpStdioCommand(typeof flags["service-url"] === "string" ? flags["service-url"] : undefined)
    return
  }

  if (command === "provider" && subcommand === "set") {
    const providerAlias = resolveProviderAliasInput(flags.provider)
    const apiKey = flags["api-key"]
    if (typeof apiKey !== "string") {
      throw new Error("provider set requires --provider and --api-key")
    }
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    if (!profile.providers) profile.providers = {}
    profile.providers[providerAlias] = { apiKey }
    saveConfig(config)
    print({ ok: true, provider: providerAlias, profile: profileName, configFile: CONFIG_FILE })
    return
  }

  if (command === "provider" && subcommand === "use") {
    const provider = resolveProviderAliasInput(flags.provider)
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    profile.defaultProvider = provider
    saveConfig(config)
    print({ ok: true, profile: profileName, defaultProvider: provider, configFile: CONFIG_FILE })
    return
  }

  if (command === "provider" && subcommand === "list") {
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    const providers = Object.entries(profile.providers || {}).map(([name, value]) => ({
      provider: name,
      configured: Boolean(value?.apiKey),
      apiKeyPreview: value?.apiKey ? `${String(value.apiKey).slice(0, 6)}...` : "",
    }))
    print({ profile: profileName, defaultProvider: profile.defaultProvider, providers })
    return
  }

  if (command === "models") {
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    const provider = flags.provider ? resolveProviderAliasInput(flags.provider) : resolveProviderAlias(profile, flags.provider)
    const providerApiKeys = buildProviderApiKeys(config, profileName)
    const data = await postJson(`${config.serviceUrl}/providers/models`, buildModelsRequest(provider, providerApiKeys))
    print(data)
    return
  }

  if (command === "config" && subcommand === "set") {
    const key = flags.key
    const rawValue = flags.value
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new Error("config set requires --key")
    }
    if (typeof rawValue !== "string") {
      throw new Error("config set requires --value")
    }
    const type = typeof flags.type === "string" ? flags.type : "auto"
    if (!["auto", "string", "number", "boolean", "json"].includes(type)) {
      throw new Error("config set --type must be one of auto|string|number|boolean|json")
    }
    const devVarsPath = typeof flags["dev-vars"] === "string"
      ? path.resolve(process.cwd(), flags["dev-vars"])
      : path.resolve(process.cwd(), ".dev.vars")

    const baseConfig = readDevVarsConfigJson(devVarsPath) || JSON.parse(JSON.stringify(PROJECT_CONFIG))
    if (!hasPath(PROJECT_CONFIG, key)) {
      throw new Error(`Unknown config key: ${key}`)
    }
    const value = parseConfigValue(rawValue, type)
    setPath(baseConfig, key, value)
    writeDevVarsConfigJson(devVarsPath, baseConfig)
    print({ ok: true, key, value, devVarsPath })
    return
  }

  if (command === "model" && subcommand === "set") {
    const model = flags.model
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("model set requires --model")
    }
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    const provider = flags.provider ? resolveProviderAliasInput(flags.provider) : resolveProviderAlias(profile, flags.provider)
    profile.models[provider] = model
    saveConfig(config)
    print({ ok: true, profile: profileName, provider, model, configFile: CONFIG_FILE })
    return
  }

  if (command === "model" && subcommand === "get") {
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    const provider = flags.provider ? resolveProviderAliasInput(flags.provider) : resolveProviderAlias(profile, flags.provider)
    const model = resolveDefaultModel(profile, provider)
    print({ profile: profileName, provider, model })
    return
  }

  if (command === "model" && subcommand === "list") {
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    print({
      profile: profileName,
      defaultProvider: profile.defaultProvider,
      models: profile.models || {},
      projectDefaultModel: PROJECT_DEFAULT_MODEL,
    })
    return
  }

  if (command === "tools") {
    const config = loadConfig()
    const response = await fetch(`${config.serviceUrl}/tools/catalog`)
    const data = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(data))
    print(data)
    return
  }

  if (command === "document") {
    const local = await loadLocalDocumentApi()
    const pdfPath = rest[0]
    const workspaceDir = typeof flags.workspace === "string" ? flags.workspace : undefined
    const forceRefresh = flags["force-refresh"] === true
    const renderScale = typeof flags.scale === "string" ? Number(flags.scale) : undefined
    if (typeof pdfPath !== "string" || pdfPath.length === 0) {
      throw new Error("document command requires a pdf path argument")
    }
    if (subcommand === "index" || subcommand === "get") {
      const data = await local.get_document({ pdfPath, workspaceDir, forceRefresh })
      print(data)
      return
    }
    if (subcommand === "structure") {
      const data = await local.get_document_structure({ pdfPath, workspaceDir, forceRefresh })
      print(data)
      return
    }
    if (subcommand === "page") {
      const pageNumber = typeof flags.page === "string" ? Number(flags.page) : NaN
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error("document page requires --page <positive integer>")
      }
      const data = await local.get_page_content({ pdfPath, workspaceDir, forceRefresh, pageNumber })
      print(data)
      return
    }
    if (subcommand === "render") {
      const pageNumber = typeof flags.page === "string" ? Number(flags.page) : NaN
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error("document render requires --page <positive integer>")
      }
      const data = await local.get_page_render({ pdfPath, workspaceDir, forceRefresh, pageNumber, renderScale })
      print(data)
      return
    }
    if (subcommand === "ocr") {
      const pageNumber = typeof flags.page === "string" ? Number(flags.page) : NaN
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error("document ocr requires --page <positive integer>")
      }
      const data = await local.get_page_ocr({
        pdfPath,
        workspaceDir,
        forceRefresh,
        pageNumber,
        renderScale,
        provider: typeof flags.provider === "string" ? flags.provider : undefined,
        model: typeof flags.model === "string" ? flags.model : undefined,
        prompt: typeof flags.prompt === "string" ? flags.prompt : undefined,
      })
      print(data)
      return
    }
    throw new Error("document command supports: index|get|structure|page|render|ocr")
  }

  if (command === "call") {
    const config = loadConfig()
    const profileName = getProfileName(config, flags.profile)
    const profile = getProfile(config, profileName)
    const tool = flags.tool
    if (typeof tool !== "string") throw new Error("call requires --tool")
    const args = typeof flags.args === "string" ? JSON.parse(flags.args) : {}
    const autoUpload = flags["auto-upload"] === true
    const prepared = await prepareArgsWithLocalUploads(config.serviceUrl, tool, args, {
      autoUpload,
    })
    if (prepared.uploads.length > 0) {
      process.stderr.write(`[echo-pdf] auto-uploaded local files:\n`)
      for (const item of prepared.uploads) {
        process.stderr.write(`  - ${item.localPath} -> ${item.fileId} (${item.tool})\n`)
      }
    }
    const preparedArgs = prepared.args
    const provider = resolveProviderAlias(profile, flags.provider)
    const model = typeof flags.model === "string" ? flags.model : resolveDefaultModel(profile, provider)
    const providerApiKeys = buildProviderApiKeys(config, profileName)
    const payload = buildToolCallRequest({ tool, args: preparedArgs, provider, model, providerApiKeys })
    const data = await postJson(`${config.serviceUrl}/tools/call`, payload)
    print(data)
    return
  }

  if (command === "file") {
    const action = rest[0] || ""
    const config = loadConfig()
    if (action === "upload") {
      const filePath = rest[1]
      if (!filePath) throw new Error("file upload requires a path")
      const data = await uploadFile(config.serviceUrl, filePath)
      print({
        fileId: data?.file?.id || "",
        filename: data?.file?.filename || path.basename(filePath),
        sizeBytes: data?.file?.sizeBytes || 0,
        file: data?.file || null,
      })
      return
    }
    if (action === "get") {
      const fileId = typeof flags["file-id"] === "string" ? flags["file-id"] : ""
      const out = typeof flags.out === "string" ? flags.out : ""
      if (!fileId || !out) throw new Error("file get requires --file-id and --out")
      const savedTo = await downloadFile(config.serviceUrl, fileId, out)
      print({ ok: true, fileId, savedTo })
      return
    }
    throw new Error("file command supports: upload|get")
  }

  if (command === "mcp" && subcommand === "initialize") {
    const config = loadConfig()
    const data = await postJson(`${config.serviceUrl}/mcp`, buildMcpRequest(1, "initialize"), buildMcpHeaders())
    print(data)
    return
  }

  if (command === "mcp" && subcommand === "tools") {
    const config = loadConfig()
    const data = await postJson(`${config.serviceUrl}/mcp`, buildMcpRequest(2, "tools/list"), buildMcpHeaders())
    print(data)
    return
  }

  if (command === "mcp" && subcommand === "call") {
    const config = loadConfig()
    const tool = flags.tool
    if (typeof tool !== "string") throw new Error("mcp call requires --tool")
    const args = typeof flags.args === "string" ? JSON.parse(flags.args) : {}
    const data = await postJson(
      `${config.serviceUrl}/mcp`,
      buildMcpRequest(3, "tools/call", { name: tool, arguments: args }),
      buildMcpHeaders()
    )
    print(data)
    return
  }

  if (command === "mcp" && subcommand === "stdio") {
    await runMcpStdioCommand(typeof flags["service-url"] === "string" ? flags["service-url"] : undefined)
    return
  }

  if (command === "setup" && subcommand === "add") {
    const tool = rest[0]
    if (!tool) throw new Error("setup add requires tool name")
    const config = loadConfig()
    const mode = typeof flags.mode === "string" ? flags.mode : "http"
    if (!["http", "stdio"].includes(mode)) throw new Error("setup add --mode must be http|stdio")
    print(setupSnippet(tool, config.serviceUrl, mode))
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
