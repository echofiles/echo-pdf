import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import packageJson from "../package.json" with { type: "json" }

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")
const outDir = process.env.ECHO_PDF_DAILY_OUT_DIR
  ? path.resolve(process.cwd(), process.env.ECHO_PDF_DAILY_OUT_DIR)
  : path.join(rootDir, "eval", "out", "daily-growth")
const npmCacheDir = path.join(os.tmpdir(), "echo-pdf-daily-growth-npm-cache")

const docsBaseUrl = String(process.env.ECHO_PDF_DAILY_DOCS_URL || "https://pdf.echofile.ai").replace(/\/+$/, "")
const repository = String(process.env.GITHUB_REPOSITORY || "JFHuang746/echo-pdf")
const [owner, repo] = repository.split("/")
let githubToken = process.env.GITHUB_TOKEN?.trim() || ""
const now = new Date().toISOString()

const trimOutput = (value, max = 1200) => {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[truncated]`
}

const looksLikeHtml = (text) => /<!doctype html|<html[\s>]/i.test(text)

const run = async (cmd, args, cwd = rootDir, extraEnv = {}) => {
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: npmCacheDir,
        ...extraEnv,
      },
      maxBuffer: 16 * 1024 * 1024,
    })
    return {
      ok: true,
      cmd,
      args,
      cwd,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
    }
  } catch (error) {
    return {
      ok: false,
      cmd,
      args,
      cwd,
      durationMs: Date.now() - startedAt,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const ensureGitHubToken = async () => {
  if (githubToken) return githubToken
  const token = await run("gh", ["auth", "token"])
  if (token.ok && token.stdout.trim()) {
    githubToken = token.stdout.trim()
  }
  return githubToken
}

const fetchText = async (url) => {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "echo-pdf-daily-growth/1.0",
      },
    })
    const text = await response.text()
    return {
      ok: response.ok,
      url,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      bodyPreview: trimOutput(text, 800),
      text,
    }
  } catch (error) {
    return {
      ok: false,
      url,
      status: 0,
      contentType: "",
      bodyPreview: trimOutput(error instanceof Error ? error.message : String(error), 800),
      text: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const fetchGitHubJson = async (apiPath) => {
  const token = await ensureGitHubToken()
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      "user-agent": "echo-pdf-daily-growth/1.0",
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub API ${apiPath} failed: HTTP ${response.status} ${trimOutput(text, 400)}`)
  }
  return response.json()
}

const collectDocsSignal = async () => {
  const home = await fetchText(`${docsBaseUrl}/`)
  const llms = await fetchText(`${docsBaseUrl}/llms.txt`)
  const robots = await fetchText(`${docsBaseUrl}/robots.txt`)
  const sitemap = await fetchText(`${docsBaseUrl}/sitemap.xml`)

  return {
    baseUrl: docsBaseUrl,
    homepage: {
      url: home.url,
      ok: home.ok,
      status: home.status,
      contentType: home.contentType,
      hasOgTitle: /property="og:title"/.test(home.text),
      hasTwitterCard: /name="twitter:card"/.test(home.text),
      hasAgentExample: /Copyable output example/.test(home.text),
      hasProofElement: /Artifact tree a human can read fast/.test(home.text),
      title: (home.text.match(/<title>([^<]+)<\/title>/i) || [])[1] || "",
      bodyPreview: home.bodyPreview,
    },
    llms: {
      url: llms.url,
      ok: llms.ok,
      status: llms.status,
      contentType: llms.contentType,
      looksLikeHtml: looksLikeHtml(llms.text),
      bodyPreview: llms.bodyPreview,
    },
    robots: {
      url: robots.url,
      ok: robots.ok,
      status: robots.status,
      contentType: robots.contentType,
      looksLikeHtml: looksLikeHtml(robots.text),
      bodyPreview: robots.bodyPreview,
    },
    sitemap: {
      url: sitemap.url,
      ok: sitemap.ok,
      status: sitemap.status,
      contentType: sitemap.contentType,
      looksLikeHtml: looksLikeHtml(sitemap.text),
      hasUrlset: /<urlset[\s>]/i.test(sitemap.text),
      bodyPreview: sitemap.bodyPreview,
    },
  }
}

const collectNpmSignal = async () => {
  const packageName = packageJson.name
  const view = await run("npm", ["view", packageName, "version", "dist-tags", "--json"])
  if (!view.ok) {
    return {
      packageName,
      repoVersion: packageJson.version,
      visible: false,
      error: trimOutput(view.error || view.stderr || view.stdout, 800),
    }
  }
  const parsed = JSON.parse(view.stdout)
  return {
    packageName,
    repoVersion: packageJson.version,
    visible: true,
    latestVersion: typeof parsed?.version === "string" ? parsed.version : "",
    distTags: parsed?.["dist-tags"] && typeof parsed["dist-tags"] === "object" ? parsed["dist-tags"] : {},
    matchesRepoVersion: typeof parsed?.version === "string" ? parsed.version === packageJson.version : false,
  }
}

const collectRepoSignal = async () => {
  try {
    const [openIssuesSearch, openPrsSearch, mergedPulls, recentClosedIssues] = await Promise.all([
      fetchGitHubJson(`/search/issues?q=repo:${owner}/${repo}+is:issue+is:open&per_page=1`),
      fetchGitHubJson(`/search/issues?q=repo:${owner}/${repo}+is:pr+is:open&per_page=1`),
      fetchGitHubJson(`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10`),
      fetchGitHubJson(`/repos/${owner}/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=10`),
    ])

    return {
      repository,
      openIssuesCount: Number(openIssuesSearch?.total_count || 0),
      openPullRequestsCount: Number(openPrsSearch?.total_count || 0),
      recentMergedPullRequests: (Array.isArray(mergedPulls) ? mergedPulls : [])
        .filter((item) => item?.merged_at)
        .slice(0, 5)
        .map((item) => ({
          number: item.number,
          title: item.title,
          mergedAt: item.merged_at,
          url: item.html_url,
        })),
      recentClosedIssues: (Array.isArray(recentClosedIssues) ? recentClosedIssues : [])
        .filter((item) => !item?.pull_request)
        .slice(0, 5)
        .map((item) => ({
          number: item.number,
          title: item.title,
          closedAt: item.closed_at,
          url: item.html_url,
        })),
    }
  } catch (error) {
    return {
      repository,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const collectSmokeSignal = async () => {
  const smoke = {
    status: "passed",
    packFilename: "",
    consumerDir: "",
    steps: [],
  }

  const recordStep = (name, result) => {
    smoke.steps.push({
      name,
      ok: result.ok,
      durationMs: result.durationMs,
      stdoutPreview: trimOutput(result.stdout, 500),
      stderrPreview: trimOutput(result.stderr || result.error || "", 500),
    })
    if (!result.ok) smoke.status = "failed"
  }

  const build = await run("npm", ["run", "build"])
  recordStep("build", build)
  if (!build.ok) return smoke

  const pack = await run("npm", ["pack", "--json"])
  recordStep("npm-pack", pack)
  if (!pack.ok) return smoke

  const parsedPack = JSON.parse(pack.stdout)
  const filename = parsedPack?.[0]?.filename
  smoke.packFilename = typeof filename === "string" ? filename : ""
  if (!smoke.packFilename) {
    smoke.status = "failed"
    smoke.steps.push({
      name: "resolve-pack-filename",
      ok: false,
      durationMs: 0,
      stdoutPreview: "",
      stderrPreview: "npm pack did not return a filename",
    })
    return smoke
  }

  const tgzPath = path.join(rootDir, smoke.packFilename)
  const consumerDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-growth-"))
  smoke.consumerDir = consumerDir

  try {
    const npmInit = await run("npm", ["init", "-y"], consumerDir)
    recordStep("consumer-npm-init", npmInit)
    if (!npmInit.ok) return smoke

    const npmInstall = await run("npm", ["i", tgzPath], consumerDir)
    recordStep("consumer-install-package", npmInstall)
    if (!npmInstall.ok) return smoke

    const importCheck = await run(
      "node",
      [
        "--input-type=module",
        "-e",
        [
          "const root = await import('@echofiles/echo-pdf')",
          "const core = await import('@echofiles/echo-pdf/core')",
          "const local = await import('@echofiles/echo-pdf/local')",
          "const worker = await import('@echofiles/echo-pdf/worker')",
          "if (typeof root.callTool !== 'function') throw new Error('root.callTool missing')",
          "if (typeof core.listToolSchemas !== 'function') throw new Error('core.listToolSchemas missing')",
          "if (typeof local.get_document !== 'function') throw new Error('local.get_document missing')",
          "if (!worker.default || typeof worker.default.fetch !== 'function') throw new Error('worker.fetch missing')",
          "console.log('ok')",
        ].join(";"),
      ],
      consumerDir
    )
    recordStep("consumer-import-smoke", importCheck)
    if (!importCheck.ok) return smoke

    const cliHelp = await run("node", ["node_modules/@echofiles/echo-pdf/bin/echo-pdf.js", "--help"], consumerDir)
    recordStep("consumer-cli-help", cliHelp)
    return smoke
  } finally {
    await rm(consumerDir, { recursive: true, force: true })
    if (smoke.packFilename) {
      await rm(path.join(rootDir, smoke.packFilename), { force: true })
    }
  }
}

const toMarkdown = (report) => {
  const docs = report.docsSite
  const npm = report.npm
  const repoSignal = report.repo
  const smoke = report.smoke

  return [
    "# Daily Growth Report",
    "",
    `Generated at: ${report.generatedAt}`,
    `Repository: ${report.repository}`,
    "",
    "## What This Report Means",
    "",
    "- `docsSite`: health and machine-consumable discovery status for the published docs site.",
    "- `npm`: package visibility and version discoverability on the npm registry.",
    "- `repo`: open issue/PR counts plus recent merged PRs and closed issues.",
    "- `smoke`: deterministic package install/import/CLI checks from a fresh consumer.",
    "",
    "This report is collection-only. It does not make product judgments or open issues automatically.",
    "",
    "## Docs Site",
    "",
    `- Homepage: HTTP ${docs.homepage.status} (${docs.homepage.ok ? "ok" : "not ok"})`,
    `- Homepage metadata: og=${docs.homepage.hasOgTitle}, twitter=${docs.homepage.hasTwitterCard}`,
    `- Homepage agent example present: ${docs.homepage.hasAgentExample}`,
    `- Homepage proof element present: ${docs.homepage.hasProofElement}`,
    `- /llms.txt: HTTP ${docs.llms.status}, html=${docs.llms.looksLikeHtml}`,
    `- /robots.txt: HTTP ${docs.robots.status}, html=${docs.robots.looksLikeHtml}`,
    `- /sitemap.xml: HTTP ${docs.sitemap.status}, html=${docs.sitemap.looksLikeHtml}, urlset=${docs.sitemap.hasUrlset}`,
    "",
    "## npm",
    "",
    `- Package: ${npm.packageName}`,
    `- Repo version: ${npm.repoVersion}`,
    `- Visible on registry: ${npm.visible}`,
    ...(npm.visible
      ? [
          `- Latest visible version: ${npm.latestVersion}`,
          `- Latest matches repo version: ${npm.matchesRepoVersion}`,
          `- Dist tags: ${JSON.stringify(npm.distTags)}`,
        ]
      : [`- Error: ${npm.error || "unknown"}`]),
    "",
    "## Repo",
    "",
    ...(repoSignal.error
      ? [`- Error: ${repoSignal.error}`]
      : [
          `- Open issues: ${repoSignal.openIssuesCount}`,
          `- Open PRs: ${repoSignal.openPullRequestsCount}`,
          "",
          "### Recent merged PRs",
          ...(repoSignal.recentMergedPullRequests.length > 0
            ? repoSignal.recentMergedPullRequests.map((item) => `- #${item.number} ${item.title} (${item.mergedAt})`)
            : ["- none observed"]),
          "",
          "### Recent closed issues",
          ...(repoSignal.recentClosedIssues.length > 0
            ? repoSignal.recentClosedIssues.map((item) => `- #${item.number} ${item.title} (${item.closedAt})`)
            : ["- none observed"]),
        ]),
    "",
    "## Minimal Smoke",
    "",
    `- Overall status: ${smoke.status}`,
    `- Pack filename: ${smoke.packFilename || "(not produced)"}`,
    "",
    "### Steps",
    ...smoke.steps.map(
      (step) =>
        `- ${step.name}: ${step.ok ? "passed" : "failed"} (${step.durationMs}ms)` +
        (step.stderrPreview ? `\n  - stderr/error: ${step.stderrPreview.replace(/\n/g, " ")}` : "")
    ),
    "",
  ].join("\n")
}

const main = async () => {
  await mkdir(outDir, { recursive: true })

  const [docsSite, npm, repoSignal, smoke] = await Promise.all([
    collectDocsSignal(),
    collectNpmSignal(),
    collectRepoSignal(),
    collectSmokeSignal(),
  ])

  const report = {
    generatedAt: now,
    repository,
    docsSite,
    npm,
    repo: repoSignal,
    smoke,
  }

  const jsonPath = path.join(outDir, "daily-growth.json")
  const markdownPath = path.join(outDir, "daily-growth.md")
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf-8")

  process.stdout.write(`wrote ${jsonPath}\n`)
  process.stdout.write(`wrote ${markdownPath}\n`)
}

await main()
