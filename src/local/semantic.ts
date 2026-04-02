/// <reference path="../node/compat.d.ts" />

import { readFile } from "node:fs/promises"
import path from "node:path"
import { resolveModelForProvider, resolveProviderAlias } from "../provider-defaults.js"
import { toDataUrl } from "../file-utils.js"
import { generateText, visionRecognize } from "../provider-client.js"
import type { EchoPdfConfig } from "../pdf-types.js"
import type { Env } from "../types.js"
import { ensureRenderArtifact, indexDocumentInternal } from "./document.js"
import {
  fileExists,
  matchesSourceSnapshot,
  matchesStrategyKey,
  pageLabel,
  parseJsonObject,
  parseJsonObjectWithRepair,
  readJson,
  resolveConfig,
  resolveEnv,
  writeJson,
} from "./shared.js"
import { normalizeFigureItems, normalizeUnderstandingFormulas, normalizeUnderstandingTables } from "./understanding.js"
import type {
  LocalPageContent,
  LocalSemanticDocumentRequest,
  LocalSemanticDocumentStructure,
  LocalSemanticStructureNode,
  MergedFigureItem,
  MergedFormulaItem,
  MergedTableItem,
  SemanticAgentCandidate,
  StoredDocumentRecord,
} from "./types.js"

const resolveSemanticExtractionBudget = (
  input?: LocalSemanticDocumentRequest["semanticExtraction"]
): { pageSelection: "all"; chunkMaxChars: number; chunkOverlapChars: number } => ({
  pageSelection: "all",
  chunkMaxChars: typeof input?.chunkMaxChars === "number" && Number.isFinite(input.chunkMaxChars) && input.chunkMaxChars > 400
    ? Math.floor(input.chunkMaxChars)
    : 4000,
  chunkOverlapChars: typeof input?.chunkOverlapChars === "number" && Number.isFinite(input.chunkOverlapChars) && input.chunkOverlapChars >= 0
    ? Math.floor(input.chunkOverlapChars)
    : 300,
})

const normalizeSemanticAgentCandidate = (
  value: unknown,
  pageNumber: number
): SemanticAgentCandidate | null => {
  const candidate = value as {
    title?: unknown
    level?: unknown
    excerpt?: unknown
    confidence?: unknown
  }
  const title = typeof candidate?.title === "string" ? candidate.title.trim() : ""
  const level = typeof candidate?.level === "number" && Number.isInteger(candidate.level) && candidate.level > 0
    ? candidate.level
    : 0
  const confidence = typeof candidate?.confidence === "number" && Number.isFinite(candidate.confidence)
    ? Math.max(0, Math.min(1, candidate.confidence))
    : 0
  if (!title || level <= 0 || confidence < 0.6) return null
  return {
    title,
    level,
    pageNumber,
    excerpt: typeof candidate?.excerpt === "string" ? candidate.excerpt.trim() : undefined,
    confidence,
  }
}

const toSemanticTree = (
  value: unknown,
  pageArtifactPaths: ReadonlyMap<number, string>
): ReadonlyArray<LocalSemanticStructureNode> => {
  if (!Array.isArray(value)) return []
  const nodes: LocalSemanticStructureNode[] = []
  value.forEach((item, index) => {
    const node = item as {
      title?: unknown
      level?: unknown
      pageNumber?: unknown
      excerpt?: unknown
      children?: unknown
    }
    const title = typeof node.title === "string" ? node.title.trim() : ""
    const level = typeof node.level === "number" && Number.isInteger(node.level) && node.level > 0 ? node.level : undefined
    const pageNumber =
      typeof node.pageNumber === "number" && Number.isInteger(node.pageNumber) && node.pageNumber > 0 ? node.pageNumber : undefined
    if (!title || typeof level !== "number" || typeof pageNumber !== "number") return
    nodes.push({
      id: `semantic-node-${index + 1}-${pageNumber}-${level}`,
      type: "section",
      title,
      level,
      pageNumber,
      pageArtifactPath: pageArtifactPaths.get(pageNumber),
      excerpt: typeof node.excerpt === "string" ? node.excerpt.trim() : undefined,
      children: toSemanticTree(node.children, pageArtifactPaths),
    })
  })
  return nodes
}

const buildCombinedPagePrompt = (
  page: LocalPageContent,
  renderScale: number
): string => {
  return [
    "Analyze this rendered PDF page image. Extract headings, tables, formulas, and figures.",
    "Primary evidence is the page image layout. Use the extracted page text as supporting context.",
    "Return JSON only.",
    "Schema:",
    "{",
    '  "candidates": [{ "title": "string", "level": 1, "excerpt": "short evidence", "confidence": 0.0 }],',
    '  "tables": [{ "latexTabular": "\\\\begin{tabular}...\\\\end{tabular}", "caption": "optional", "truncatedTop": false, "truncatedBottom": false }],',
    '  "formulas": [{ "latexMath": "LaTeX expression", "label": "optional", "truncatedTop": false, "truncatedBottom": false }],',
    '  "figures": [{ "figureType": "schematic|chart|photo|diagram|other", "caption": "optional", "description": "brief description", "truncatedTop": false, "truncatedBottom": false }]',
    "}",
    "Heading rules:",
    "- candidates: true document headings/sections supported by page layout plus text.",
    "- Prefer conservative extraction. Do not include table headers, field labels, or prose sentences.",
    "- Confidence reflects how likely the candidate is a real navigational section heading.",
    "Table rules:",
    "- Tables must be complete LaTeX tabular environments.",
    "Formula rules:",
    "- Use LaTeX math notation. Skip trivial inline math or single symbols.",
    "Figure rules:",
    "- Describe by type, caption, and brief visual description. Do not crop or encode images.",
    "Truncation:",
    "- Set truncatedTop/truncatedBottom to true if elements appear cut off at the page boundary.",
    "Empty:",
    '- If nothing found for a category, return an empty array for that key.',
    `Page number: ${page.pageNumber}`,
    `Render scale: ${renderScale}`,
    "",
    "Extracted page text:",
    page.text,
  ].join("\n")
}

const buildSemanticAggregationPrompt = (
  record: StoredDocumentRecord,
  candidates: ReadonlyArray<{
    title: string
    level: number
    pageNumber: number
    excerpt?: string
    confidence?: number
  }>
): string => {
  const candidateDump = JSON.stringify({ candidates }, null, 2)
  return [
    "You assemble semantic document structure from page-understanding heading candidates.",
    "Return JSON only.",
    "Schema:",
    "{",
    '  "sections": [',
    "    {",
    '      "title": "string",',
    '      "level": 1,',
    '      "pageNumber": 1,',
    '      "excerpt": "short evidence string",',
    '      "children": []',
    "    }",
    "  ]",
    "}",
    "Rules:",
    "- Preserve hierarchy with nested children.",
    "- Use only candidate headings that form a reliable document structure.",
    "- Favor candidates with strong confidence and clear section semantics; drop visually prominent noise.",
    "- Deduplicate repeated headings from overlapping segments.",
    "- Do not invent sections not present in the candidates.",
    '- If no reliable semantic structure is detectable, return {"sections":[]}.',
    `Document filename: ${record.filename}`,
    `Page count: ${record.pageCount}`,
    "",
    candidateDump,
  ].join("\n")
}

const resolveSemanticAgentContext = (
  config: EchoPdfConfig,
  request: LocalSemanticDocumentRequest
): { provider: string; model: string } => {
  const provider = resolveProviderAlias(config, request.provider)
  const model = resolveModelForProvider(config, provider, request.model)
  if (!provider || !model) {
    throw new Error(
      [
        "semantic extraction requires a configured provider and model.",
        "Pass `provider` and `model` to `get_semantic_document_structure()`",
        "or configure them first with `echo-pdf provider use --provider <alias>` and `echo-pdf model set --provider <alias> --model <model-id>`.",
      ].join(" ")
    )
  }
  return { provider, model }
}

interface PageUnderstandingElements {
  readonly pageNumber: number
  readonly tables: ReadonlyArray<import("./types.js").LocalPageUnderstandingTableItem>
  readonly formulas: ReadonlyArray<import("./types.js").LocalPageUnderstandingFormulaItem>
  readonly figures: ReadonlyArray<import("./types.js").LocalFigureArtifactItem>
}

interface CombinedPageResult {
  candidates: ReadonlyArray<SemanticAgentCandidate>
  elements: PageUnderstandingElements
}

class SemanticAggregationModelOutputError extends Error {
  readonly code = "SEMANTIC_AGGREGATION_INVALID_JSON"

  constructor(
    message: string,
    readonly detail: {
      provider: string
      model: string
      repaired: boolean
      retried: boolean
      causeMessage?: string
    }
  ) {
    super(message)
    this.name = "SemanticAggregationModelOutputError"
  }
}

const extractCombinedPageData = async (input: {
  page: LocalPageContent
  request: LocalSemanticDocumentRequest
  config: EchoPdfConfig
  env: Env
  provider: string
  model: string
}): Promise<CombinedPageResult> => {
  const renderArtifact = await ensureRenderArtifact({
    pdfPath: input.request.pdfPath,
    workspaceDir: input.request.workspaceDir,
    forceRefresh: input.request.forceRefresh,
    config: input.config,
    pageNumber: input.page.pageNumber,
  })
  const imageBytes = new Uint8Array(await readFile(renderArtifact.imagePath))
  const imageDataUrl = toDataUrl(imageBytes, renderArtifact.mimeType)
  const response = await visionRecognize({
    config: input.config,
    env: input.env,
    providerAlias: input.provider,
    model: input.model,
    prompt: buildCombinedPagePrompt(input.page, renderArtifact.renderScale),
    imageDataUrl,
    runtimeApiKeys: input.request.providerApiKeys,
  })
  const parsed = parseJsonObject(response) as {
    candidates?: unknown[]
    tables?: unknown
    formulas?: unknown
    figures?: unknown
  }
  const candidates = (Array.isArray(parsed?.candidates) ? parsed.candidates : [])
    .map((c) => normalizeSemanticAgentCandidate(c, input.page.pageNumber))
    .filter((c): c is SemanticAgentCandidate => c !== null)

  const tables = normalizeUnderstandingTables(parsed?.tables)
  const formulas = normalizeUnderstandingFormulas(parsed?.formulas)
  const figures = normalizeFigureItems(parsed?.figures)

  return {
    candidates,
    elements: {
      pageNumber: input.page.pageNumber,
      tables,
      formulas,
      figures,
    },
  }
}

const buildSemanticAggregationRetryPrompt = (
  record: StoredDocumentRecord,
  candidates: ReadonlyArray<{
    title: string
    level: number
    pageNumber: number
    excerpt?: string
    confidence?: number
  }>
): string => {
  return [
    buildSemanticAggregationPrompt(record, candidates),
    "",
    "Your previous response was not strict JSON.",
    "Return the same semantic structure again, but this time produce strict RFC 8259 JSON only.",
    "Do not wrap in markdown fences.",
    "Do not use invalid backslash escapes such as \\(, \\), \\_, or \\- inside JSON strings.",
  ].join("\n")
}

const parseSemanticAggregationResponse = async (input: {
  aggregated: string
  record: StoredDocumentRecord
  candidates: ReadonlyArray<SemanticAgentCandidate>
  config: EchoPdfConfig
  env: Env
  provider: string
  model: string
  runtimeApiKeys?: Record<string, string>
}): Promise<{ sections?: unknown; repaired: boolean; retried: boolean }> => {
  try {
    const parsed = parseJsonObjectWithRepair(input.aggregated)
    return {
      sections: (parsed.parsed as { sections?: unknown } | null)?.sections,
      repaired: parsed.repaired,
      retried: false,
    }
  } catch (firstError) {
    const causeMessage = firstError instanceof Error ? firstError.message : String(firstError)
    const retried = await generateText({
      config: input.config,
      env: input.env,
      providerAlias: input.provider,
      model: input.model,
      prompt: buildSemanticAggregationRetryPrompt(input.record, input.candidates),
      runtimeApiKeys: input.runtimeApiKeys,
    })
    try {
      const parsed = parseJsonObjectWithRepair(retried)
      return {
        sections: (parsed.parsed as { sections?: unknown } | null)?.sections,
        repaired: parsed.repaired,
        retried: true,
      }
    } catch (retryError) {
      const retryCauseMessage = retryError instanceof Error ? retryError.message : String(retryError)
      throw new SemanticAggregationModelOutputError(
        "semantic aggregation returned invalid JSON after repair and retry",
        {
          provider: input.provider,
          model: input.model,
          repaired: false,
          retried: true,
          causeMessage: `${causeMessage}; retry=${retryCauseMessage}`,
        }
      )
    }
  }
}

const mergeCrossPageTables = (
  understandings: ReadonlyArray<PageUnderstandingElements>
): MergedTableItem[] => {
  const merged: MergedTableItem[] = []
  let nextId = 1
  for (const pu of understandings) {
    for (const table of pu.tables) {
      const prev = merged[merged.length - 1]
      if (prev?.crossPageHint && table.truncatedTop) {
        merged[merged.length - 1] = {
          ...prev,
          latexTabular: prev.latexTabular + "\n" + table.latexTabular,
          endPage: pu.pageNumber,
        }
      } else {
        merged.push({
          id: `merged-table-${nextId++}`,
          latexTabular: table.latexTabular,
          caption: table.caption,
          startPage: pu.pageNumber,
          endPage: pu.pageNumber,
          crossPageHint: table.truncatedBottom === true ? true : undefined,
        })
      }
    }
  }
  return merged
}

const mergeCrossPageFormulas = (
  understandings: ReadonlyArray<PageUnderstandingElements>
): MergedFormulaItem[] => {
  const merged: MergedFormulaItem[] = []
  let nextId = 1
  for (const pu of understandings) {
    for (const formula of pu.formulas) {
      const prev = merged[merged.length - 1]
      if (prev?.crossPageHint && formula.truncatedTop) {
        merged[merged.length - 1] = {
          ...prev,
          latexMath: prev.latexMath + " " + formula.latexMath,
          endPage: pu.pageNumber,
        }
      } else {
        merged.push({
          id: `merged-formula-${nextId++}`,
          latexMath: formula.latexMath,
          label: formula.label,
          startPage: pu.pageNumber,
          endPage: pu.pageNumber,
          crossPageHint: formula.truncatedBottom === true ? true : undefined,
        })
      }
    }
  }
  return merged
}

const mergeCrossPageFigures = (
  understandings: ReadonlyArray<PageUnderstandingElements>
): MergedFigureItem[] => {
  const merged: MergedFigureItem[] = []
  let nextId = 1
  for (const pu of understandings) {
    for (const figure of pu.figures) {
      const prev = merged[merged.length - 1]
      if (prev?.crossPageHint && figure.truncatedTop) {
        merged[merged.length - 1] = {
          ...prev,
          description: [prev.description, figure.description].filter(Boolean).join(" "),
          endPage: pu.pageNumber,
        }
      } else {
        merged.push({
          id: `merged-figure-${nextId++}`,
          figureType: figure.figureType,
          caption: figure.caption,
          description: figure.description,
          startPage: pu.pageNumber,
          endPage: pu.pageNumber,
          crossPageHint: figure.truncatedBottom === true ? true : undefined,
        })
      }
    }
  }
  return merged
}

const ensureSemanticStructureArtifact = async (
  request: LocalSemanticDocumentRequest
): Promise<LocalSemanticDocumentStructure> => {
  const env = resolveEnv(request.env)
  const config = resolveConfig(request.config, env)
  const { record } = await indexDocumentInternal(request)
  const artifactPath = record.artifactPaths.semanticStructureJsonPath
  const semanticBudget = resolveSemanticExtractionBudget(request.semanticExtraction)
  const { provider, model } = resolveSemanticAgentContext(config, request)
  const strategyKey =
    `agent::page-understanding-v1::${provider}::${model}::${config.service.defaultRenderScale}::${semanticBudget.pageSelection}::${semanticBudget.chunkMaxChars}::${semanticBudget.chunkOverlapChars}`
  if (!request.forceRefresh && await fileExists(artifactPath)) {
    const cached = await readJson<Omit<LocalSemanticDocumentStructure, "cacheStatus"> & { cacheStatus?: unknown }>(artifactPath)
    if (matchesSourceSnapshot(cached, record) && matchesStrategyKey(cached, strategyKey)) {
      return {
        ...cached,
        cacheStatus: "reused",
      }
    }
  }

  const pages: LocalPageContent[] = []
  for (let pageNumber = 1; pageNumber <= record.pageCount; pageNumber += 1) {
    const pagePath = path.join(record.artifactPaths.pagesDir, `${pageLabel(pageNumber)}.json`)
    const page = await readJson<LocalPageContent>(pagePath)
    pages.push(page)
  }
  const pageArtifactPaths = new Map(pages.map((page) => [page.pageNumber, page.artifactPath]))

  const candidateMap = new Map<string, SemanticAgentCandidate>()
  const pageElements: PageUnderstandingElements[] = []
  for (const page of pages) {
    const result = await extractCombinedPageData({
      page,
      request,
      config,
      env,
      provider,
      model,
    })
    for (const candidate of result.candidates) {
      const key = `${candidate.pageNumber}:${candidate.level}:${candidate.title}`
      const existing = candidateMap.get(key)
      if (!existing || candidate.confidence > existing.confidence) {
        candidateMap.set(key, candidate)
      }
    }
    pageElements.push(result.elements)
  }

  const aggregated = await generateText({
    config,
    env,
    providerAlias: provider,
    model,
    prompt: buildSemanticAggregationPrompt(record, [...candidateMap.values()]),
    runtimeApiKeys: request.providerApiKeys,
  })
  const parsed = await parseSemanticAggregationResponse({
    aggregated,
    record,
    candidates: [...candidateMap.values()],
    config,
    env,
    provider,
    model,
    runtimeApiKeys: request.providerApiKeys,
  })
  const sections = toSemanticTree(parsed.sections, pageArtifactPaths)

  const mergedTables = mergeCrossPageTables(pageElements)
  const mergedFormulas = mergeCrossPageFormulas(pageElements)
  const mergedFigures = mergeCrossPageFigures(pageElements)

  const artifact: Omit<LocalSemanticDocumentStructure, "cacheStatus"> = {
    documentId: record.documentId,
    generatedAt: new Date().toISOString(),
    detector: "agent-structured-v1",
    strategyKey,
    sourceSizeBytes: record.sizeBytes,
    sourceMtimeMs: record.mtimeMs,
    pageIndexArtifactPath: record.artifactPaths.structureJsonPath,
    artifactPath,
    root: {
      id: `semantic-${record.documentId}`,
      type: "document",
      title: record.filename,
      children: sections,
    },
    ...(mergedTables.length > 0 ? { tables: mergedTables } : {}),
    ...(mergedFormulas.length > 0 ? { formulas: mergedFormulas } : {}),
    ...(mergedFigures.length > 0 ? { figures: mergedFigures } : {}),
  }

  await writeJson(artifactPath, artifact)
  return {
    ...artifact,
    cacheStatus: "fresh",
  }
}

export const get_semantic_document_structure = async (
  request: LocalSemanticDocumentRequest
): Promise<LocalSemanticDocumentStructure> => ensureSemanticStructureArtifact(request)
