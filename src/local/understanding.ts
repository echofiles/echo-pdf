/// <reference path="../node/compat.d.ts" />

import { readFile } from "node:fs/promises"
import path from "node:path"
import { toDataUrl } from "../file-utils.js"
import { visionRecognize } from "../provider-client.js"
import { ensureRenderArtifact, indexDocumentInternal } from "./document.js"
import {
  buildStructuredArtifactPath,
  ensurePageNumber,
  fileExists,
  matchesSourceSnapshot,
  normalizeFormulaItems,
  normalizeTableItems,
  pageLabel,
  parseJsonObject,
  readJson,
  resolveAgentSelection,
  resolveConfig,
  resolveEnv,
  resolveRenderScale,
  stripCodeFences,
  writeJson,
} from "./shared.js"
import type {
  LocalFigureArtifactItem,
  LocalPageUnderstandingArtifact,
  LocalPageUnderstandingFormulaItem,
  LocalPageUnderstandingRequest,
  LocalPageUnderstandingTableItem,
} from "./types.js"

const DEFAULT_UNDERSTANDING_PROMPT = [
  "Analyze this rendered PDF page image. Extract all tables, displayed formulas, and figures.",
  "Return JSON only. Schema:",
  "{",
  '  "tables": [{ "latexTabular": "\\\\begin{tabular}...\\\\end{tabular}", "caption": "optional", "truncatedTop": false, "truncatedBottom": false }],',
  '  "formulas": [{ "latexMath": "LaTeX expression", "label": "optional", "truncatedTop": false, "truncatedBottom": false }],',
  '  "figures": [{ "figureType": "schematic|chart|photo|diagram|other", "caption": "optional", "description": "brief visual description", "truncatedTop": false, "truncatedBottom": false }]',
  "}",
  "Rules:",
  "- Tables must be complete LaTeX tabular environments.",
  "- Formulas must use LaTeX math notation. Skip trivial inline math or single symbols.",
  "- Figures should be described by type, caption, and a brief visual description. Do not crop or encode images.",
  "- Set truncatedTop/truncatedBottom to true if the element appears cut off at the page boundary.",
  '- If nothing is found for a category, return an empty array for that key.',
].join("\n")

const normalizeFigureItems = (value: unknown): LocalFigureArtifactItem[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const figure = item as {
      figureType?: unknown
      caption?: unknown
      description?: unknown
      truncatedTop?: unknown
      truncatedBottom?: unknown
    }
    const figureType = typeof figure.figureType === "string" ? figure.figureType.trim() : "other"
    const validTypes = new Set(["schematic", "chart", "photo", "diagram", "other"])
    return [{
      id: `figure-${index + 1}`,
      figureType: validTypes.has(figureType) ? figureType as LocalFigureArtifactItem["figureType"] : "other",
      caption: typeof figure.caption === "string" ? figure.caption.trim() : undefined,
      description: typeof figure.description === "string" ? figure.description.trim() : undefined,
      truncatedTop: figure.truncatedTop === true,
      truncatedBottom: figure.truncatedBottom === true,
    }]
  })
}

const normalizeUnderstandingTables = (value: unknown): LocalPageUnderstandingTableItem[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const table = item as {
      latexTabular?: unknown
      caption?: unknown
      truncatedTop?: unknown
      truncatedBottom?: unknown
    }
    const latexTabular = typeof table.latexTabular === "string" ? stripCodeFences(table.latexTabular).trim() : ""
    if (!latexTabular.includes("\\begin{tabular}") || !latexTabular.includes("\\end{tabular}")) return []
    return [{
      id: `table-${index + 1}`,
      latexTabular,
      caption: typeof table.caption === "string" ? table.caption.trim() : undefined,
      truncatedTop: table.truncatedTop === true,
      truncatedBottom: table.truncatedBottom === true,
    }]
  })
}

const normalizeUnderstandingFormulas = (value: unknown): LocalPageUnderstandingFormulaItem[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const formula = item as {
      latexMath?: unknown
      label?: unknown
      truncatedTop?: unknown
      truncatedBottom?: unknown
    }
    const latexMath = typeof formula.latexMath === "string" ? stripCodeFences(formula.latexMath).trim() : ""
    if (!latexMath) return []
    return [{
      id: `formula-${index + 1}`,
      latexMath,
      label: typeof formula.label === "string" ? formula.label.trim() : undefined,
      truncatedTop: formula.truncatedTop === true,
      truncatedBottom: formula.truncatedBottom === true,
    }]
  })
}

export const get_page_understanding = async (
  request: LocalPageUnderstandingRequest
): Promise<LocalPageUnderstandingArtifact> => {
  const env = resolveEnv(request.env)
  const config = resolveConfig(request.config, env)
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)

  const { provider, model } = resolveAgentSelection(config, request)
  const renderScale = resolveRenderScale(config, request.renderScale)
  const prompt = typeof request.prompt === "string" && request.prompt.trim().length > 0
    ? request.prompt.trim()
    : DEFAULT_UNDERSTANDING_PROMPT

  const understandingDir = path.join(record.artifactPaths.documentDir, "understanding")
  const artifactPath = buildStructuredArtifactPath(understandingDir, request.pageNumber, renderScale, provider, model, prompt)

  if (!request.forceRefresh && await fileExists(artifactPath)) {
    const cached = await readJson<Omit<LocalPageUnderstandingArtifact, "cacheStatus"> & { cacheStatus?: unknown }>(artifactPath)
    if (matchesSourceSnapshot(cached, record)) {
      return { ...cached, cacheStatus: "reused" }
    }
  }

  const renderArtifact = await ensureRenderArtifact({
    pdfPath: request.pdfPath,
    workspaceDir: request.workspaceDir,
    forceRefresh: request.forceRefresh,
    config,
    pageNumber: request.pageNumber,
    renderScale: request.renderScale,
  })

  const imageBytes = new Uint8Array(await readFile(renderArtifact.imagePath))
  const imageDataUrl = toDataUrl(imageBytes, renderArtifact.mimeType)

  const response = await visionRecognize({
    config,
    env,
    providerAlias: provider,
    model,
    prompt,
    imageDataUrl,
    runtimeApiKeys: request.providerApiKeys,
  })

  const parsed = parseJsonObject(response) as { tables?: unknown; formulas?: unknown; figures?: unknown }
  const tables = normalizeUnderstandingTables(parsed?.tables)
  const formulas = normalizeUnderstandingFormulas(parsed?.formulas)
  const figures = normalizeFigureItems(parsed?.figures)

  const pageArtifactPath = path.join(record.artifactPaths.pagesDir, `${pageLabel(request.pageNumber)}.json`)
  const artifact: Omit<LocalPageUnderstandingArtifact, "cacheStatus"> = {
    documentId: record.documentId,
    pageNumber: request.pageNumber,
    renderScale,
    sourceSizeBytes: record.sizeBytes,
    sourceMtimeMs: record.mtimeMs,
    provider,
    model,
    prompt,
    imagePath: renderArtifact.imagePath,
    pageArtifactPath,
    renderArtifactPath: renderArtifact.artifactPath,
    artifactPath,
    generatedAt: new Date().toISOString(),
    tables,
    formulas,
    figures,
  }

  await writeJson(artifactPath, artifact)
  return { ...artifact, cacheStatus: "fresh" }
}
