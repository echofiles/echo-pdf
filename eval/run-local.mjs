#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"
import { createHash } from "node:crypto"
import { classifyThrownError, resolveRunStatus } from "./summary-utils.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const manifestRoot = path.join(__dirname, "manifests")
const outRoot = path.join(__dirname, "out")

const SUMMARY_VERSION = "echo-pdf.eval.run-summary.v1"

const parseFlags = (argv) => {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}

const readJson = async (targetPath) => JSON.parse(await fs.readFile(targetPath, "utf-8"))

const writeJson = async (targetPath, value) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

const writeText = async (targetPath, value) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, value, "utf-8")
}

const toTimestampLabel = (value) =>
  value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")

const flattenSections = (node) => {
  const children = Array.isArray(node?.children) ? node.children : []
  const output = []
  for (const child of children) {
    output.push(child)
    output.push(...flattenSections(child))
  }
  return output
}

const stableHash = (value, length = 10) => createHash("sha256").update(value).digest("hex").slice(0, length)

const escapePdfText = (value) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")

const makeContentStream = (lines) => {
  const sanitized = lines.map((line) => escapePdfText(String(line)))
  const body = ["BT", "/F1 18 Tf", "72 760 Td"]
  sanitized.forEach((line, index) => {
    if (index > 0) body.push("0 -24 Td")
    body.push(`(${line}) Tj`)
  })
  body.push("ET")
  return `${body.join("\n")}\n`
}

const writeSimplePdf = async (targetPath, pages) => {
  const objects = []
  objects.push("<< /Type /Catalog /Pages 2 0 R >>")
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2)
  const contentObjectNumbers = pages.map((_, index) => 5 + index * 2)
  objects.push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectNumbers.map((id) => `${id} 0 R`).join(" ")}] >>`)
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

  pages.forEach((lines, index) => {
    const pageObjectNumber = pageObjectNumbers[index]
    const contentObjectNumber = contentObjectNumbers[index]
    objects[pageObjectNumber - 1] = [
      "<< /Type /Page",
      "/Parent 2 0 R",
      "/MediaBox [0 0 612 792]",
      "/Resources << /Font << /F1 3 0 R >> >>",
      `/Contents ${contentObjectNumber} 0 R`,
      ">>",
    ].join(" ")

    const stream = makeContentStream(lines)
    objects[contentObjectNumber - 1] = [
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>`,
      "stream",
      stream.trimEnd(),
      "endstream",
    ].join("\n")
  })

  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((objectBody, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "utf8")
    pdf += `${index + 1} 0 obj\n${objectBody}\nendobj\n`
  })

  const xrefOffset = Buffer.byteLength(pdf, "utf8")
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += "0000000000 65535 f \n"
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index] || 0).padStart(10, "0")} 00000 n \n`
  }
  pdf += [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n")

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, pdf, "utf8")
}

const resolveString = (value, envKey) => {
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    const envValue = process.env[envKey.trim()]
    if (typeof envValue === "string" && envValue.trim().length > 0) return envValue.trim()
  }
  return ""
}

const compareDocument = (document, expectations) => {
  const failures = []
  if (typeof expectations?.pageCount === "number" && document.pageCount !== expectations.pageCount) {
    failures.push({
      code: "DOCUMENT_PAGE_COUNT_MISMATCH",
      layer: "document",
      message: `Expected pageCount=${expectations.pageCount}, got ${document.pageCount}.`,
    })
  }
  return failures
}

const compareSemantic = (semantic, expectations) => {
  const failures = []
  const sections = flattenSections(semantic.root)

  if (Array.isArray(expectations?.allowedDetectors) && expectations.allowedDetectors.length > 0) {
    if (!expectations.allowedDetectors.includes(semantic.detector)) {
      failures.push({
        code: "SEMANTIC_FALLBACK_DRIFT",
        layer: "semantic",
        message: `Detector ${semantic.detector} is outside allowedDetectors.`,
      })
    }
  }

  if (typeof expectations?.minRootChildren === "number") {
    const rootChildren = Array.isArray(semantic.root?.children) ? semantic.root.children.length : 0
    if (rootChildren < expectations.minRootChildren) {
      failures.push({
        code: "SEMANTIC_UNDERSPECIFIED_STRUCTURE",
        layer: "semantic",
        message: `Expected at least ${expectations.minRootChildren} root sections, got ${rootChildren}.`,
      })
    }
  }

  if (typeof expectations?.maxRootChildren === "number") {
    const rootChildren = Array.isArray(semantic.root?.children) ? semantic.root.children.length : 0
    if (rootChildren > expectations.maxRootChildren) {
      failures.push({
        code: "SEMANTIC_HALLUCINATED_SECTION",
        layer: "semantic",
        message: `Expected at most ${expectations.maxRootChildren} root sections, got ${rootChildren}.`,
      })
    }
  }

  for (const required of Array.isArray(expectations?.requiredSections) ? expectations.requiredSections : []) {
    const found = sections.some((section) =>
      section?.title === required.title &&
      (typeof required.level !== "number" || section?.level === required.level) &&
      (typeof required.pageNumber !== "number" || section?.pageNumber === required.pageNumber)
    )
    if (!found) {
      failures.push({
        code: "SEMANTIC_MISSING_SECTION",
        layer: "semantic",
        message: `Missing required semantic section "${required.title}".`,
      })
    }
  }

  for (const requiredSubstring of Array.isArray(expectations?.requiredTitleSubstrings) ? expectations.requiredTitleSubstrings : []) {
    const found = sections.some((section) => typeof section?.title === "string" && section.title.includes(requiredSubstring))
    if (!found) {
      failures.push({
        code: "SEMANTIC_MISSING_SECTION",
        layer: "semantic",
        message: `Missing semantic section title containing "${requiredSubstring}".`,
      })
    }
  }

  for (const forbiddenTitle of Array.isArray(expectations?.forbiddenTitles) ? expectations.forbiddenTitles : []) {
    const found = sections.some((section) => section?.title === forbiddenTitle)
    if (found) {
      failures.push({
        code: "SEMANTIC_FORBIDDEN_SECTION",
        layer: "semantic",
        message: `Found forbidden semantic section "${forbiddenTitle}".`,
      })
    }
  }

  for (const forbiddenSubstring of Array.isArray(expectations?.forbiddenTitleSubstrings) ? expectations.forbiddenTitleSubstrings : []) {
    const found = sections.some((section) => typeof section?.title === "string" && section.title.includes(forbiddenSubstring))
    if (found) {
      failures.push({
        code: "SEMANTIC_FORBIDDEN_SECTION",
        layer: "semantic",
        message: `Found forbidden semantic section containing "${forbiddenSubstring}".`,
      })
    }
  }

  return {
    failures,
    metrics: {
      detector: semantic.detector,
      strategyKey: semantic.strategyKey,
      rootSectionCount: Array.isArray(semantic.root?.children) ? semantic.root.children.length : 0,
      flattenedSectionCount: sections.length,
    },
  }
}

const buildRepresentativeRuns = (runs, limit = 3) => {
  const pick = (status) => runs.filter((run) => run.status === status).slice(0, limit).map((run) => run.runId)
  return {
    passed: pick("passed"),
    failed: pick("failed"),
    blocked: pick("blocked"),
    knownBad: pick("known-bad"),
    unexpectedPass: pick("unexpected-pass"),
  }
}

const incrementCount = (map, key) => {
  map[key] = (map[key] || 0) + 1
}

const loadLocalDocumentApi = async () => {
  const distPath = path.join(repoRoot, "dist", "local", "index.js")
  try {
    return await import(pathToFileURL(distPath).href)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to load built local document API at ${distPath}. Run "npm run build" first. Detail: ${message}`
    )
  }
}

const materializeSource = async (manifestDir, suiteRunDir, caseDef) => {
  const source = caseDef.source || {}
  if (source.kind === "existing") {
    return {
      kind: "existing",
      pdfPath: path.resolve(manifestDir, source.path),
      generated: false,
    }
  }
  if (source.kind === "generated" && source.generator === "simple-text-pages") {
    const filename = typeof source.filename === "string" && source.filename.length > 0
      ? source.filename
      : `${caseDef.caseId}.pdf`
    const pdfPath = path.join(suiteRunDir.generatedDir, filename)
    await writeSimplePdf(pdfPath, Array.isArray(source.pages) ? source.pages : [])
    return {
      kind: "generated",
      pdfPath,
      generated: true,
    }
  }
  throw new Error(`Unsupported source definition for case ${caseDef.caseId}`)
}

const run = async () => {
  const flags = parseFlags(process.argv.slice(2))
  const suiteId = typeof flags.suite === "string" && flags.suite.trim().length > 0 ? flags.suite.trim() : "smoke"
  const manifestPath = typeof flags.manifest === "string"
    ? path.resolve(process.cwd(), flags.manifest)
    : path.join(manifestRoot, `${suiteId}.json`)

  const manifest = await readJson(manifestPath)
  const manifestDir = path.dirname(manifestPath)
  const now = new Date()
  const timestamp = toTimestampLabel(now)
  const labelBase = `${manifest.suiteId || suiteId}-${timestamp}`
  const suiteRunDir = {
    baseDir: path.join(outRoot, labelBase),
    generatedDir: path.join(outRoot, `${labelBase}.generated`),
    workspaceDir: typeof flags.workspace === "string"
      ? path.resolve(process.cwd(), flags.workspace)
      : path.join(outRoot, `${labelBase}.workspace`),
    summaryPath: typeof flags.out === "string"
      ? path.resolve(process.cwd(), flags.out)
      : path.join(outRoot, `${labelBase}.summary.json`),
  }
  await fs.mkdir(suiteRunDir.baseDir, { recursive: true })
  await fs.mkdir(suiteRunDir.generatedDir, { recursive: true })
  await fs.mkdir(suiteRunDir.workspaceDir, { recursive: true })

  const local = await loadLocalDocumentApi()
  const semanticConfigById = new Map((manifest.semanticConfigs || []).map((config) => [config.id, config]))
  const runs = []
  const taxonomyCounts = {}
  const statusCounts = {
    passed: 0,
    failed: 0,
    blocked: 0,
    "known-bad": 0,
    "unexpected-pass": 0,
  }

  for (const caseDef of manifest.cases || []) {
    const source = await materializeSource(manifestDir, suiteRunDir, caseDef)
    const expectedOutcome = typeof caseDef.expectedOutcome === "string" ? caseDef.expectedOutcome : "pass"
    const documentStart = Date.now()
    let documentResult
    let materializationError = null

    try {
      documentResult = await local.get_document({
        pdfPath: source.pdfPath,
        workspaceDir: suiteRunDir.workspaceDir,
      })
    } catch (error) {
      materializationError = classifyThrownError(error)
    }

    const documentFailures = materializationError ? [materializationError] : compareDocument(documentResult, caseDef.documentExpectations)
    const documentStatus = resolveRunStatus("pass", documentFailures, caseDef.expectedFailureCodes)

    const documentRun = {
      runId: `${manifest.suiteId}::document::${caseDef.caseId}`,
      suiteId: manifest.suiteId,
      caseId: caseDef.caseId,
      kind: "document",
      configId: "document-baseline",
      status: documentStatus,
      durationMs: Date.now() - documentStart,
      source,
      config: {
        mode: "document-baseline",
      },
      failures: documentFailures,
      metrics: documentResult ? {
        pageCount: documentResult.pageCount,
        cacheStatus: documentResult.cacheStatus,
      } : {},
      artifacts: documentResult?.artifactPaths || {},
      notes: caseDef.description,
    }
    runs.push(documentRun)
    incrementCount(statusCounts, documentStatus)
    for (const failure of documentFailures) incrementCount(taxonomyCounts, failure.code)

    if (materializationError) continue

    for (const configId of caseDef.semanticConfigIds || []) {
      const config = semanticConfigById.get(configId)
      if (!config) throw new Error(`Unknown semantic configId "${configId}" in suite "${manifest.suiteId}"`)
      const provider = resolveString(config.provider, config.providerEnv)
      const model = resolveString(config.model, config.modelEnv)
      const missingProviderOrModel = Boolean((config.providerEnv || config.modelEnv || config.provider || config.model) && (!provider || !model))
      if (missingProviderOrModel) {
        const failure = {
          code: "ENV_PROVIDER_OR_MODEL_MISSING",
          layer: "infra",
          message: `Missing semantic provider/model for config ${configId}.`,
        }
        runs.push({
          runId: `${manifest.suiteId}::semantic::${configId}::${caseDef.caseId}`,
          suiteId: manifest.suiteId,
          caseId: caseDef.caseId,
          kind: "semantic",
          configId,
          status: "blocked",
          durationMs: 0,
          source,
          config,
          failures: [failure],
          metrics: {},
          artifacts: {},
          notes: caseDef.description,
        })
        incrementCount(statusCounts, "blocked")
        incrementCount(taxonomyCounts, failure.code)
        continue
      }

      const startedAt = Date.now()
      let semantic
      let failures = []
      try {
        semantic = await local.get_semantic_document_structure({
          pdfPath: source.pdfPath,
          workspaceDir: suiteRunDir.workspaceDir,
          provider: provider || undefined,
          model: model || undefined,
          semanticExtraction: config.budget,
        })
        failures = compareSemantic(semantic, caseDef.semanticExpectations).failures
      } catch (error) {
        failures = [classifyThrownError(error)]
      }

      const status = resolveRunStatus(expectedOutcome, failures, caseDef.expectedFailureCodes)
      const semanticMetrics = semantic ? compareSemantic(semantic, caseDef.semanticExpectations).metrics : {}

      runs.push({
        runId: `${manifest.suiteId}::semantic::${configId}::${caseDef.caseId}`,
        suiteId: manifest.suiteId,
        caseId: caseDef.caseId,
        kind: "semantic",
        configId,
        status,
        durationMs: Date.now() - startedAt,
        source,
        config: {
          provider: provider || "",
          model: model || "",
          budget: config.budget || null,
          budgetLabel: config.budgetLabel || "",
          notes: config.notes || "",
        },
        failures,
        metrics: semanticMetrics,
        artifacts: semantic ? {
          artifactPath: semantic.artifactPath,
          pageIndexArtifactPath: semantic.pageIndexArtifactPath,
        } : {},
        notes: caseDef.description,
      })
      incrementCount(statusCounts, status)
      for (const failure of failures) incrementCount(taxonomyCounts, failure.code)
    }
  }

  const summary = {
    summaryVersion: SUMMARY_VERSION,
    generatedAt: now.toISOString(),
    suite: {
      suiteId: manifest.suiteId,
      description: manifest.description || "",
      manifestPath,
    },
    environment: {
      cwd: process.cwd(),
      repoRoot,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      workspaceDir: suiteRunDir.workspaceDir,
      envHints: {
        semanticProvider: process.env.ECHO_PDF_EVAL_SEMANTIC_PROVIDER || "",
        semanticModel: process.env.ECHO_PDF_EVAL_SEMANTIC_MODEL || "",
      },
    },
    totals: {
      caseCount: Array.isArray(manifest.cases) ? manifest.cases.length : 0,
      runCount: runs.length,
      statuses: statusCounts,
      taxonomyCounts,
    },
    representativeRuns: buildRepresentativeRuns(runs),
    runs,
  }

  await writeJson(suiteRunDir.summaryPath, summary)
  const latestPath = path.join(suiteRunDir.baseDir, "LATEST.txt")
  await writeText(latestPath, `${suiteRunDir.summaryPath}\n`)

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suiteId: manifest.suiteId,
      summaryPath: suiteRunDir.summaryPath,
      workspaceDir: suiteRunDir.workspaceDir,
      statuses: statusCounts,
      taxonomyCounts,
    }, null, 2)}\n`
  )
}

run().catch((error) => {
  const failure = classifyThrownError(error)
  process.stderr.write(`${JSON.stringify({ ok: false, ...failure }, null, 2)}\n`)
  process.exitCode = 1
})
