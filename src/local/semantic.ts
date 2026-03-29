/// <reference path="../node/compat.d.ts" />

import { readFile } from "node:fs/promises"
import path from "node:path"
import { resolveModelForProvider, resolveProviderAlias } from "../agent-defaults.js"
import { toDataUrl } from "../file-utils.js"
import { generateText, visionRecognize } from "../provider-client.js"
import { buildSemanticSectionTree } from "../node/semantic-local.js"
import type { EchoPdfConfig } from "../pdf-types.js"
import type { Env } from "../types.js"
import { ensureRenderArtifact, indexDocumentInternal } from "./document.js"
import {
  fileExists,
  hashFragment,
  matchesSourceSnapshot,
  matchesStrategyKey,
  pageLabel,
  parseJsonObject,
  readJson,
  resolveConfig,
  resolveEnv,
  writeJson,
} from "./shared.js"
import type {
  LocalPageContent,
  LocalSemanticDocumentRequest,
  LocalSemanticDocumentStructure,
  LocalSemanticStructureNode,
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

const buildSemanticPageUnderstandingPrompt = (
  page: LocalPageContent,
  renderScale: number
): string => {
  return [
    "You extract semantic heading candidates from one rendered PDF page.",
    "Primary evidence is the page image layout. Use the extracted page text only as supporting context.",
    "Return JSON only.",
    "Schema:",
    "{",
    '  "candidates": [',
    "    {",
    '      "title": "string",',
    '      "level": 1,',
    '      "excerpt": "short evidence string",',
    '      "confidence": 0.0',
    "    }",
    "  ]",
    "}",
    "Rules:",
    "- Use only true document headings/sections that are clearly supported by page layout plus text.",
    "- Prefer conservative extraction over guessing.",
    "- Do not include table column headers, field labels, figure labels, unit/value rows, worksheet fragments, or prose sentences.",
    "- Do not infer hierarchy beyond the explicit heading numbering or structure visible on the page.",
    "- Confidence should reflect how likely the candidate is to be a real navigational section heading in the document.",
    '- If no reliable semantic structure is detectable, return {"candidates":[]}.',
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

const buildHeuristicSemanticArtifact = (
  record: StoredDocumentRecord,
  artifactPath: string,
  sections: ReadonlyArray<LocalSemanticStructureNode>,
  fallback?: LocalSemanticDocumentStructure["fallback"]
): Omit<LocalSemanticDocumentStructure, "cacheStatus"> => ({
  documentId: record.documentId,
  generatedAt: new Date().toISOString(),
  detector: "heading-heuristic-v1",
  strategyKey: fallback
    ? `agent-fallback::page-understanding-v1::${hashFragment(fallback.reason, 10)}`
    : "heuristic::heading-heuristic-v1",
  ...(fallback ? { fallback } : {}),
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
})

const extractSemanticCandidatesFromRenderedPage = async (input: {
  page: LocalPageContent
  request: LocalSemanticDocumentRequest
  config: EchoPdfConfig
  env: Env
  provider: string
  model: string
}): Promise<ReadonlyArray<SemanticAgentCandidate>> => {
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
    prompt: buildSemanticPageUnderstandingPrompt(input.page, renderArtifact.renderScale),
    imageDataUrl,
    runtimeApiKeys: input.request.providerApiKeys,
  })
  const parsed = parseJsonObject(response) as { candidates?: unknown[] }
  return (Array.isArray(parsed?.candidates) ? parsed.candidates : [])
    .map((candidate) => normalizeSemanticAgentCandidate(candidate, input.page.pageNumber))
    .filter((candidate): candidate is SemanticAgentCandidate => candidate !== null)
}

const summarizeSemanticAgentFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown agent semantic failure"
}

const ensureSemanticStructureArtifact = async (
  request: LocalSemanticDocumentRequest
): Promise<LocalSemanticDocumentStructure> => {
  const env = resolveEnv(request.env)
  const config = resolveConfig(request.config, env)
  const { record } = await indexDocumentInternal(request)
  const artifactPath = record.artifactPaths.semanticStructureJsonPath
  const semanticBudget = resolveSemanticExtractionBudget(request.semanticExtraction)
  let provider = ""
  let model = ""
  try {
    provider = resolveProviderAlias(config, request.provider)
    model = provider ? resolveModelForProvider(config, provider) : ""
  } catch {
    provider = ""
    model = ""
  }
  if (provider) {
    model = resolveModelForProvider(config, provider, request.model)
  }
  const strategyKey = model
    ? `agent::page-understanding-v1::${provider}::${model}::${config.service.defaultRenderScale}::${semanticBudget.pageSelection}::${semanticBudget.chunkMaxChars}::${semanticBudget.chunkOverlapChars}`
    : "heuristic::heading-heuristic-v1"
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

  let artifact: Omit<LocalSemanticDocumentStructure, "cacheStatus">
  if (model) {
    try {
      const candidateMap = new Map<string, SemanticAgentCandidate>()
      for (const page of pages) {
        const candidates = await extractSemanticCandidatesFromRenderedPage({
          page,
          request,
          config,
          env,
          provider,
          model,
        })
        for (const candidate of candidates) {
          const key = `${candidate.pageNumber}:${candidate.level}:${candidate.title}`
          const existing = candidateMap.get(key)
          if (!existing || candidate.confidence > existing.confidence) {
            candidateMap.set(key, candidate)
          }
        }
      }
      const aggregated = await generateText({
        config,
        env,
        providerAlias: provider,
        model,
        prompt: buildSemanticAggregationPrompt(record, [...candidateMap.values()]),
        runtimeApiKeys: request.providerApiKeys,
      })
      const parsed = parseJsonObject(aggregated) as { sections?: unknown }
      const sections = toSemanticTree(parsed?.sections, pageArtifactPaths)
      artifact = {
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
      }
    } catch (error) {
      artifact = buildHeuristicSemanticArtifact(
        record,
        artifactPath,
        buildSemanticSectionTree(pages),
        {
          from: "agent-structured-v1",
          to: "heading-heuristic-v1",
          reason: summarizeSemanticAgentFailure(error),
        }
      )
    }
  } else {
    artifact = buildHeuristicSemanticArtifact(record, artifactPath, buildSemanticSectionTree(pages))
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
