#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CONFIG_DIR = path.join(os.homedir(), ".config", "echo-pdf-cli")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")
const DEFAULT_SERVICE_URL = process.env.ECHO_PDF_SERVICE_URL || "https://xx.echofilesai.workers.dev"

const defaultConfig = () => ({
  serviceUrl: DEFAULT_SERVICE_URL,
  profile: "default",
  profiles: {
    default: {
      providers: {
        openai: { apiKey: "" },
        openrouter: { apiKey: "" },
        "vercel-ai-gateway": { apiKey: "" },
      },
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
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
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
    config.profiles[profileName] = { providers: {} }
  }
  return config.profiles[profileName]
}

const buildProviderApiKeys = (config, profileName) => {
  const profile = getProfile(config, profileName)
  return {
    openai: profile.providers?.openai?.apiKey || "",
    openrouter: profile.providers?.openrouter?.apiKey || "",
    "vercel-ai-gateway": profile.providers?.["vercel-ai-gateway"]?.apiKey || "",
  }
}

const postJson = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

const print = (data) => {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

const usage = () => {
  process.stdout.write(`echo-pdf CLI\n\n`)
  process.stdout.write(`Commands:\n`)
  process.stdout.write(`  init [--service-url URL]\n`)
  process.stdout.write(`  provider set --provider <openai|openrouter|vercel-ai-gateway> --api-key <KEY> [--profile name]\n`)
  process.stdout.write(`  provider list [--profile name]\n`)
  process.stdout.write(`  models [--provider alias] [--profile name]\n`)
  process.stdout.write(`  tools\n`)
  process.stdout.write(`  call --tool <name> --args '<json>' [--provider alias] [--model model] [--profile name]\n`)
  process.stdout.write(`  mcp initialize\n`)
  process.stdout.write(`  mcp tools\n`)
  process.stdout.write(`  mcp call --tool <name> --args '<json>'\n`)
  process.stdout.write(`  setup add <claude-desktop|claude-code|cursor|cline|windsurf|gemini|json>\n`)
}

const setupSnippet = (tool, serviceUrl) => {
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

  const [command, subcommand, ...rest] = argv
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

  if (command === "provider" && subcommand === "set") {
    const provider = flags.provider
    const apiKey = flags["api-key"]
    if (typeof provider !== "string" || typeof apiKey !== "string") {
      throw new Error("provider set requires --provider and --api-key")
    }
    const config = loadConfig()
    const profile = getProfile(config, flags.profile)
    if (!profile.providers) profile.providers = {}
    profile.providers[provider] = { apiKey }
    saveConfig(config)
    print({ ok: true, provider, profile: flags.profile || config.profile, configFile: CONFIG_FILE })
    return
  }

  if (command === "provider" && subcommand === "list") {
    const config = loadConfig()
    const profileName = flags.profile || config.profile
    const profile = getProfile(config, profileName)
    const providers = Object.entries(profile.providers || {}).map(([name, value]) => ({
      provider: name,
      configured: Boolean(value?.apiKey),
      apiKeyPreview: value?.apiKey ? `${String(value.apiKey).slice(0, 6)}...` : "",
    }))
    print({ profile: profileName, providers })
    return
  }

  if (command === "models") {
    const config = loadConfig()
    const provider = typeof flags.provider === "string" ? flags.provider : "openrouter"
    const providerApiKeys = buildProviderApiKeys(config, flags.profile)
    const data = await postJson(`${config.serviceUrl}/providers/models`, { provider, providerApiKeys })
    print(data)
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

  if (command === "call") {
    const config = loadConfig()
    const tool = flags.tool
    if (typeof tool !== "string") throw new Error("call requires --tool")
    const args = typeof flags.args === "string" ? JSON.parse(flags.args) : {}
    const providerApiKeys = buildProviderApiKeys(config, flags.profile)
    const payload = {
      name: tool,
      arguments: args,
      provider: typeof flags.provider === "string" ? flags.provider : undefined,
      model: typeof flags.model === "string" ? flags.model : undefined,
      providerApiKeys,
    }
    const data = await postJson(`${config.serviceUrl}/tools/call`, payload)
    print(data)
    return
  }

  if (command === "mcp" && subcommand === "initialize") {
    const config = loadConfig()
    const data = await postJson(`${config.serviceUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })
    print(data)
    return
  }

  if (command === "mcp" && subcommand === "tools") {
    const config = loadConfig()
    const data = await postJson(`${config.serviceUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })
    print(data)
    return
  }

  if (command === "mcp" && subcommand === "call") {
    const config = loadConfig()
    const tool = flags.tool
    if (typeof tool !== "string") throw new Error("mcp call requires --tool")
    const args = typeof flags.args === "string" ? JSON.parse(flags.args) : {}
    const data = await postJson(`${config.serviceUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: tool,
        arguments: args,
      },
    })
    print(data)
    return
  }

  if (command === "setup" && subcommand === "add") {
    const tool = rest[0]
    if (!tool) throw new Error("setup add requires tool name")
    const config = loadConfig()
    print(setupSnippet(tool, config.serviceUrl))
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
