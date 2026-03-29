#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"
import { createHash } from "node:crypto"

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

const classifyThrownError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/Missing required env var/i.test(message)) {
    return { code: "ENV_PROVIDER_KEY_MISSING", layer: "infra", message }
  }
  if (/model is required/i.test(message) || /Provider ".+" not configured/i.test(message)) {
    return { code: "ENV_PROVIDER_OR_MODEL_MISSING", layer: "infra", message }
  }
  if (/timeout/i.test(message)) {
    return { code: "INFRA_REQUEST_TIMEOUT", layer: "infra", message }
  }
  if (/HTTP 401|HTTP 403/i.test(message)) {
    return { code: "INFRA_PROVIDER_AUTH_FAILED", layer: "infra", message }
  }
  if (/HTTP 429/i.test(message)) {
    return { code: "INFRA_PROVIDER_RATE_LIMITED", layer: "infra", message }
  }
  if (/not valid JSON/i.test(message)) {
    return { code: "SEMANTIC_MODEL_OUTPUT_INVALID", layer: "semantic", message }
  }
  if (/Failed to load PDF|pageNumber must be within/i.test(message)) {
    return { code: "INPUT_PDF_INVALID", layer: "sample", message }
  }
  return { code: "RUNNER_UNCLASSIFIED_ERROR", layer: "runner", message }
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

const compareOcr = (ocr, expectations) => {
  const failures = []
  const text = typeof ocr.text === "string" ? ocr.text : ""

  if (typeof expectations?.minChars === "number" && text.length < expectations.minChars) {
    failures.push({
      code: "OCR_TRUNCATED_TEXT",
      layer: "ocr",
      message: `Expected at least ${expectations.minChars} chars, got ${text.length}.`,
    })
  }

  for (const required of Array.isArray(expectations?.requiredSubstrings) ? expectations.requiredSubstrings : []) {
    if (!text.includes(required)) {
      failures.push({
        code: "OCR_TEXT_MISSING",
        layer: "ocr",
        message: `Missing OCR substring "${required}".`,
      })
    }
  }

  for (const forbidden of Array.isArray(expectations?.forbiddenSubstrings) ? expectations.forbiddenSubstrings : []) {
    if (text.includes(forbidden)) {
      failures.push({
        code: "OCR_HALLUCINATED_TEXT",
        layer: "ocr",
        message: `Found forbidden OCR substring "${forbidden}".`,
      })
    }
  }

  return {
    failures,
    metrics: {
      chars: text.length,
      provider: ocr.provider,
      model: ocr.model,
      renderScale: ocr.renderScale,
      promptHash: stableHash(ocr.prompt || ""),
    },
  }
}

const finalizeStatus = (expectedOutcome, failures, expectedFailureCodes) => {
  if (failures.length === 0) {
    return expectedOutcome === "known-bad" ? "unexpected-pass" : "passed"
  }
  if (expectedOutcome === "known-bad") {
    const expectedCodes = new Set(Array.isArray(expectedFailureCodes) ? expectedFailureCodes : [])
    const onlyExpected = expectedCodes.size === 0 || failures.every((failure) => expectedCodes.has(failure.code))
    return onlyExpected ? "known-bad" : "failed"
  }
  return "failed"
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

const readPrompt = async (manifestDir, promptFile, inlinePrompt) => {
  if (typeof inlinePrompt === "string" && inlinePrompt.trim().length > 0) return inlinePrompt.trim()
  if (typeof promptFile === "string" && promptFile.trim().length > 0) {
    return (await fs.readFile(path.resolve(manifestDir, promptFile), "utf-8")).trim()
  }
  return ""
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
  const ocrConfigById = new Map((manifest.ocrConfigs || []).map((config) => [config.id, config]))
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
    const documentStatus = materializationError?.code === "ENV_PROVIDER_KEY_MISSING"
      ? "blocked"
      : finalizeStatus("pass", documentFailures, caseDef.expectedFailureCodes)

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

      const status = failures.some((failure) => failure.code.startsWith("ENV_")) ? "blocked" : finalizeStatus(expectedOutcome, failures, caseDef.expectedFailureCodes)
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

    for (const configId of caseDef.ocrConfigIds || []) {
      const config = ocrConfigById.get(configId)
      if (!config) throw new Error(`Unknown ocr configId "${configId}" in suite "${manifest.suiteId}"`)
      const provider = resolveString(config.provider, config.providerEnv)
      const model = resolveString(config.model, config.modelEnv)
      const missingProviderOrModel = !provider || !model
      if (missingProviderOrModel) {
        const failure = {
          code: "ENV_PROVIDER_OR_MODEL_MISSING",
          layer: "infra",
          message: `Missing OCR provider/model for config ${configId}.`,
        }
        runs.push({
          runId: `${manifest.suiteId}::ocr::${configId}::${caseDef.caseId}`,
          suiteId: manifest.suiteId,
          caseId: caseDef.caseId,
          kind: "ocr",
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
      const prompt = await readPrompt(manifestDir, config.promptFile, config.prompt)
      let ocr
      let failures = []
      try {
        ocr = await local.get_page_ocr({
          pdfPath: source.pdfPath,
          workspaceDir: suiteRunDir.workspaceDir,
          pageNumber: caseDef.ocrExpectations?.pageNumber || 1,
          provider,
          model,
          prompt,
          renderScale: typeof config.renderScale === "number" ? config.renderScale : undefined,
        })
        failures = compareOcr(ocr, caseDef.ocrExpectations).failures
      } catch (error) {
        failures = [classifyThrownError(error)]
      }

      const status = failures.some((failure) => failure.code.startsWith("ENV_")) ? "blocked" : finalizeStatus(expectedOutcome, failures, caseDef.expectedFailureCodes)
      const ocrMetrics = ocr ? compareOcr(ocr, caseDef.ocrExpectations).metrics : {}

      runs.push({
        runId: `${manifest.suiteId}::ocr::${configId}::${caseDef.caseId}`,
        suiteId: manifest.suiteId,
        caseId: caseDef.caseId,
        kind: "ocr",
        configId,
        status,
        durationMs: Date.now() - startedAt,
        source,
        config: {
          provider,
          model,
          budgetLabel: config.budgetLabel || "",
          renderScale: config.renderScale || "",
          promptHash: stableHash(prompt),
          promptFile: config.promptFile || "",
          notes: config.notes || "",
        },
        failures,
        metrics: ocrMetrics,
        artifacts: ocr ? {
          artifactPath: ocr.artifactPath,
          renderArtifactPath: ocr.renderArtifactPath,
          imagePath: ocr.imagePath,
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
        ocrProvider: process.env.ECHO_PDF_EVAL_OCR_PROVIDER || "",
        ocrModel: process.env.ECHO_PDF_EVAL_OCR_MODEL || "",
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
