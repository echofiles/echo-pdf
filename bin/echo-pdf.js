#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CONFIG_DIR = path.join(os.homedir(), ".config", "echo-pdf-cli")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_CONFIG_FILE = path.resolve(__dirname, "../echo-pdf.config.json")
const PROJECT_CONFIG = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, "utf-8"))
const PROVIDER_ENTRIES = Object.entries(PROJECT_CONFIG.providers || {})
const PROVIDER_ALIASES = PROVIDER_ENTRIES.map(([alias]) => alias)
const PROVIDER_ALIAS_BY_TYPE = new Map(PROVIDER_ENTRIES.map(([alias, provider]) => [provider.type, alias]))
const PROVIDER_SET_NAMES = Array.from(new Set(PROVIDER_ENTRIES.flatMap(([alias, provider]) => [alias, provider.type])))
const PROJECT_DEFAULT_MODEL = String(PROJECT_CONFIG.agent?.defaultModel || "").trim()

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

const saveConfig = (config) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
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

const loadConfig = () => {
  ensureConfig()
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
  if (!config.profiles || typeof config.profiles !== "object") config.profiles = {}
  if (typeof config.profile !== "string" || !config.profile) config.profile = "default"
  getProfile(config, config.profile)
  saveConfig(config)
  return config
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

const readEnvApiKey = (providerAlias) => {
  const providerConfig = PROJECT_CONFIG.providers?.[providerAlias]
  const keyName = providerConfig?.apiKeyEnv
  if (typeof keyName !== "string" || keyName.trim().length === 0) return ""
  const read = (name) => {
    const value = process.env[name]
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : ""
  }
  const direct = read(keyName)
  if (direct) return direct
  if (keyName.endsWith("_API_KEY")) {
    return read(keyName.replace(/_API_KEY$/, "_KEY"))
  }
  if (keyName.endsWith("_KEY")) {
    return read(keyName.replace(/_KEY$/, "_API_KEY"))
  }
  return ""
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

const resolveLocalSemanticContext = (flags) => {
  const config = loadConfig()
  const profileName = getProfileName(config, flags.profile)
  const profile = getProfile(config, profileName)
  const provider = resolveProviderAlias(profile, flags.provider)
  const model = typeof flags.model === "string" ? flags.model.trim() : resolveDefaultModel(profile, provider)
  if (!model) {
    throw new Error(
      [
        `semantic requires a configured model for provider "${provider}".`,
        `Pass \`--model <model-id>\`, or run \`echo-pdf model set --provider ${provider} --model <model-id>${profileName ? ` --profile ${profileName}` : ""}\`.`,
      ].join(" ")
    )
  }
  const providerApiKeys = buildProviderApiKeys(config, profileName)
  const configuredApiKey = typeof providerApiKeys[provider] === "string" ? providerApiKeys[provider].trim() : ""
  if (!configuredApiKey && !readEnvApiKey(provider)) {
    const apiKeyEnv = PROJECT_CONFIG.providers?.[provider]?.apiKeyEnv || "PROVIDER_API_KEY"
    throw new Error(
      [
        `semantic requires an API key for provider "${provider}".`,
        `Run \`echo-pdf provider set --provider ${provider} --api-key <KEY>${profileName ? ` --profile ${profileName}` : ""}\``,
        `or export \`${apiKeyEnv}\` before running the VL-first semantic path.`,
      ].join(" ")
    )
  }
  return { provider, model, providerApiKeys }
}

const print = (data) => {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

const LOCAL_DOCUMENT_DIST_ENTRY = new URL("../dist/local/index.js", import.meta.url)
const LOCAL_DOCUMENT_SOURCE_ENTRY = new URL("../src/local/index.ts", import.meta.url)
const IS_BUN_RUNTIME = typeof process.versions?.bun === "string"
const SHOULD_PREFER_SOURCE_DOCUMENT_API = process.env.ECHO_PDF_SOURCE_DEV === "1"

const loadLocalDocumentApi = async () => {
  if (SHOULD_PREFER_SOURCE_DOCUMENT_API) {
    if (IS_BUN_RUNTIME && fs.existsSync(fileURLToPath(LOCAL_DOCUMENT_SOURCE_ENTRY))) {
      return import(LOCAL_DOCUMENT_SOURCE_ENTRY.href)
    }
    throw new Error(
      "Internal source-checkout CLI dev mode requires Bun and src/local/index.ts. " +
      "Use `npm run cli:dev -- <primitive> ...` only from a source checkout."
    )
  }
  try {
    return await import(LOCAL_DOCUMENT_DIST_ENTRY.href)
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : ""
    if (code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "Local primitive commands require built artifacts in a source checkout. " +
        "Run `npm run build` first, use the internal `npm run cli:dev -- <primitive> ...` path in this repo, or install the published package."
      )
    }
    throw error
  }
}

const LOCAL_PRIMITIVE_COMMANDS = ["document", "structure", "semantic", "page", "render"]
const REMOVED_DOCUMENT_ALIAS_TO_PRIMITIVE = {
  index: "document",
  get: "document",
  structure: "structure",
  semantic: "semantic",
  page: "page",
  render: "render",
}

const isRemovedDocumentAlias = (value) =>
  typeof value === "string" && Object.hasOwn(REMOVED_DOCUMENT_ALIAS_TO_PRIMITIVE, value)

const removedDocumentAliasMessage = (alias) => {
  const primitive = REMOVED_DOCUMENT_ALIAS_TO_PRIMITIVE[alias]
  return `Legacy \`document ${alias}\` was removed. Use \`echo-pdf ${primitive} <file.pdf>\` instead.`
}

const readDocumentPrimitiveArgs = (command, subcommand, rest) => {
  if (command === "document") {
    if (isRemovedDocumentAlias(subcommand) && typeof rest[0] === "string" && !rest[0].startsWith("--")) {
      throw new Error(removedDocumentAliasMessage(subcommand))
    }
    return {
      primitive: "document",
      pdfPath: subcommand,
    }
  }
  return {
    primitive: command,
    pdfPath: rest[0],
  }
}

const runLocalPrimitiveCommand = async (command, subcommand, rest, flags) => {
  const local = await loadLocalDocumentApi()
  const { primitive, pdfPath } = readDocumentPrimitiveArgs(command, subcommand, rest)
  const workspaceDir = typeof flags.workspace === "string" ? flags.workspace : undefined
  const forceRefresh = flags["force-refresh"] === true
  const renderScale = typeof flags.scale === "string" ? Number(flags.scale) : undefined

  if (typeof pdfPath !== "string" || pdfPath.length === 0 || pdfPath.startsWith("--")) {
    throw new Error(`${primitive} requires a pdf path argument`)
  }

  if (primitive === "document") {
    print(await local.get_document({ pdfPath, workspaceDir, forceRefresh }))
    return
  }

  if (primitive === "structure") {
    print(await local.get_document_structure({ pdfPath, workspaceDir, forceRefresh }))
    return
  }

  if (primitive === "semantic") {
    const semanticContext = resolveLocalSemanticContext(flags)
    const data = await local.get_semantic_document_structure({
      pdfPath,
      workspaceDir,
      forceRefresh,
      provider: semanticContext.provider,
      model: semanticContext.model,
      providerApiKeys: semanticContext.providerApiKeys,
    })
    if (data?.fallback?.reason) {
      process.stderr.write(
        `[echo-pdf] semantic fell back from ${data.fallback.from} to ${data.fallback.to}: ${data.fallback.reason}\n`
      )
    }
    print(data)
    return
  }

  const pageNumber = typeof flags.page === "string" ? Number(flags.page) : NaN
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error(`${primitive} requires --page <positive integer>`)
  }

  if (primitive === "page") {
    print(await local.get_page_content({ pdfPath, workspaceDir, forceRefresh, pageNumber }))
    return
  }

  if (primitive === "render") {
    print(await local.get_page_render({ pdfPath, workspaceDir, forceRefresh, pageNumber, renderScale }))
    return
  }

  throw new Error(`Unsupported local primitive command: ${primitive}`)
}

const usage = () => {
  process.stdout.write(`echo-pdf CLI\n\n`)
  process.stdout.write(`Primary local primitive commands:\n`)
  process.stdout.write(`  document <file.pdf> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  structure <file.pdf> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  semantic <file.pdf> [--provider alias] [--model model] [--profile name] [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  page <file.pdf> --page <N> [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`  render <file.pdf> --page <N> [--scale N] [--workspace DIR] [--force-refresh]\n`)
  process.stdout.write(`\nLocal config commands:\n`)
  process.stdout.write(`  provider set --provider <${PROVIDER_SET_NAMES.join("|")}> --api-key <KEY> [--profile name]\n`)
  process.stdout.write(`  provider use --provider <${PROVIDER_ALIASES.join("|")}> [--profile name]\n`)
  process.stdout.write(`  provider list [--profile name]\n`)
  process.stdout.write(`  model set --model <model-id> [--provider alias] [--profile name]\n`)
  process.stdout.write(`  model get [--provider alias] [--profile name]\n`)
  process.stdout.write(`  model list [--profile name]\n`)
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
  if (["provider", "model", "document"].includes(command)) {
    subcommand = raw[0] || ""
    rest = raw.slice(1)
  }
  const flags = parseFlags(rest)

  if (command === "ocr") {
    throw new Error(
      "`echo-pdf ocr` was removed from the first-class CLI surface. OCR is migration-only and no longer a supported primary command."
    )
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

  if (LOCAL_PRIMITIVE_COMMANDS.includes(command)) {
    await runLocalPrimitiveCommand(command, subcommand, rest, flags)
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
