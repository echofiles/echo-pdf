/// <reference path="../node/compat.d.ts" />

import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveModelForProvider, resolveProviderAlias } from "../agent-defaults.js"
import { toDataUrl } from "../file-utils.js"
import { loadEchoPdfConfig } from "../pdf-config.js"
import { generateText, visionRecognize } from "../provider-client.js"
import type { EchoPdfConfig } from "../pdf-types.js"
import type { Env } from "../types.js"
import { extractLocalPdfPageText, getLocalPdfPageCount, renderLocalPdfPageToPng } from "../node/pdfium-local.js"
import { buildSemanticSectionTree } from "../node/semantic-local.js"

export interface LocalDocumentArtifactPaths {
  readonly workspaceDir: string
  readonly documentDir: string
  readonly documentJsonPath: string
  readonly structureJsonPath: string
  readonly semanticStructureJsonPath: string
  readonly pagesDir: string
  readonly rendersDir: string
}

interface InternalDocumentArtifactPaths extends LocalDocumentArtifactPaths {
  readonly ocrDir: string
}

export interface LocalDocumentMetadata {
  readonly documentId: string
  readonly sourcePath: string
  readonly filename: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly pageCount: number
  readonly indexedAt: string
  readonly cacheStatus: "fresh" | "reused"
  readonly artifactPaths: LocalDocumentArtifactPaths
}

export interface LocalDocumentStructureNode {
  readonly id: string
  readonly type: "document" | "page"
  readonly title: string
  readonly pageNumber?: number
  readonly preview?: string
  readonly artifactPath?: string
  readonly children?: ReadonlyArray<LocalDocumentStructureNode>
}

export interface LocalDocumentStructure {
  readonly documentId: string
  readonly generatedAt: string
  readonly root: LocalDocumentStructureNode
}

export interface LocalSemanticStructureNode {
  readonly id: string
  readonly type: "document" | "section"
  readonly title: string
  readonly level?: number
  readonly pageNumber?: number
  readonly pageArtifactPath?: string
  readonly excerpt?: string
  readonly children?: ReadonlyArray<LocalSemanticStructureNode>
}

export interface LocalSemanticDocumentStructure {
  readonly documentId: string
  readonly generatedAt: string
  readonly detector: "agent-structured-v1" | "heading-heuristic-v1"
  readonly strategyKey: string
  readonly sourceSizeBytes: number
  readonly sourceMtimeMs: number
  readonly pageIndexArtifactPath: string
  readonly artifactPath: string
  readonly root: LocalSemanticStructureNode
  readonly cacheStatus: "fresh" | "reused"
}

export interface LocalPageContent {
  readonly documentId: string
  readonly pageNumber: number
  readonly title: string
  readonly preview: string
  readonly text: string
  readonly chars: number
  readonly artifactPath: string
}

export interface LocalPageRenderArtifact {
  readonly documentId: string
  readonly pageNumber: number
  readonly renderScale: number
  readonly sourceSizeBytes: number
  readonly sourceMtimeMs: number
  readonly width: number
  readonly height: number
  readonly mimeType: "image/png"
  readonly imagePath: string
  readonly artifactPath: string
  readonly generatedAt: string
  readonly cacheStatus: "fresh" | "reused"
}

interface LocalPageOcrArtifact {
  readonly documentId: string
  readonly pageNumber: number
  readonly renderScale: number
  readonly sourceSizeBytes: number
  readonly sourceMtimeMs: number
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly text: string
  readonly chars: number
  readonly imagePath: string
  readonly renderArtifactPath: string
  readonly artifactPath: string
  readonly generatedAt: string
  readonly cacheStatus: "fresh" | "reused"
}

export interface LocalDocumentRequest {
  readonly pdfPath: string
  readonly workspaceDir?: string
  readonly forceRefresh?: boolean
  readonly config?: EchoPdfConfig
}

export interface LocalPageContentRequest extends LocalDocumentRequest {
  readonly pageNumber: number
}

export interface LocalSemanticDocumentRequest extends LocalDocumentRequest {
  readonly provider?: string
  readonly model?: string
  readonly semanticExtraction?: {
    readonly pageSelection?: "all"
    readonly chunkMaxChars?: number
    readonly chunkOverlapChars?: number
  }
  readonly env?: Env
  readonly providerApiKeys?: Record<string, string>
}

export interface LocalPageRenderRequest extends LocalPageContentRequest {
  readonly renderScale?: number
}

interface LocalPageOcrRequest extends LocalPageRenderRequest {
  readonly provider?: string
  readonly model?: string
  readonly prompt?: string
  readonly env?: Env
  readonly providerApiKeys?: Record<string, string>
}

interface StoredDocumentRecord {
  readonly documentId: string
  readonly sourcePath: string
  readonly filename: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly pageCount: number
  readonly indexedAt: string
  readonly artifactPaths: InternalDocumentArtifactPaths
}

const defaultWorkspaceDir = (): string => path.resolve(process.cwd(), ".echo-pdf-workspace")

const resolveWorkspaceDir = (workspaceDir?: string): string =>
  path.resolve(process.cwd(), workspaceDir?.trim() || defaultWorkspaceDir())

const toDocumentId = (absolutePdfPath: string): string =>
  createHash("sha256").update(absolutePdfPath).digest("hex").slice(0, 16)

const hashFragment = (value: string, length = 12): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length)

const sanitizeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "_")

const scaleLabel = (value: number): string => sanitizeSegment(String(value))

const pageLabel = (pageNumber: number): string => String(pageNumber).padStart(4, "0")

const buildArtifactPaths = (workspaceDir: string, documentId: string): InternalDocumentArtifactPaths => {
  const documentDir = path.join(workspaceDir, "documents", documentId)
  return {
    workspaceDir,
    documentDir,
    documentJsonPath: path.join(documentDir, "document.json"),
    structureJsonPath: path.join(documentDir, "structure.json"),
    semanticStructureJsonPath: path.join(documentDir, "semantic-structure.json"),
    pagesDir: path.join(documentDir, "pages"),
    rendersDir: path.join(documentDir, "renders"),
    ocrDir: path.join(documentDir, "ocr"),
  }
}

const toPublicArtifactPaths = (paths: InternalDocumentArtifactPaths): LocalDocumentArtifactPaths => ({
  workspaceDir: paths.workspaceDir,
  documentDir: paths.documentDir,
  documentJsonPath: paths.documentJsonPath,
  structureJsonPath: paths.structureJsonPath,
  semanticStructureJsonPath: paths.semanticStructureJsonPath,
  pagesDir: paths.pagesDir,
  rendersDir: paths.rendersDir,
})

const buildRenderArtifactPaths = (
  paths: LocalDocumentArtifactPaths,
  pageNumber: number,
  renderScale: number
): { artifactPath: string; imagePath: string } => {
  const key = `${pageLabel(pageNumber)}.scale-${scaleLabel(renderScale)}`
  return {
    artifactPath: path.join(paths.rendersDir, `${key}.json`),
    imagePath: path.join(paths.rendersDir, `${key}.png`),
  }
}

const buildOcrArtifactPath = (
  paths: InternalDocumentArtifactPaths,
  pageNumber: number,
  renderScale: number,
  provider: string,
  model: string,
  prompt: string
): string => {
  const key = [
    pageLabel(pageNumber),
    `scale-${scaleLabel(renderScale)}`,
    `provider-${sanitizeSegment(provider)}`,
    `model-${sanitizeSegment(model)}`,
    `prompt-${hashFragment(prompt, 10)}`,
  ].join(".")
  return path.join(paths.ocrDir, `${key}.json`)
}

const createPreview = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 160)

const createPageTitle = (pageNumber: number, text: string): string => {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? `Page ${pageNumber}: ${firstLine.slice(0, 80)}` : `Page ${pageNumber}`
}

const stripCodeFences = (value: string): string => {
  const text = value.trim()
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return typeof fenced?.[1] === "string" ? fenced[1].trim() : text
}

const parseJsonObject = (value: string): unknown => {
  const trimmed = stripCodeFences(value).trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new Error("semantic structure model output was not valid JSON")
  }
}

const resolveConfig = (config?: EchoPdfConfig): EchoPdfConfig => config ?? loadEchoPdfConfig({} as never)

const resolveEnv = (env?: Env): Env => env ?? (process.env as unknown as Env)

const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

const readJson = async <T>(targetPath: string): Promise<T> => {
  const raw = await readFile(targetPath, "utf-8")
  return JSON.parse(raw) as T
}

const loadStoredDocument = async (paths: InternalDocumentArtifactPaths): Promise<StoredDocumentRecord | null> => {
  if (!await fileExists(paths.documentJsonPath)) return null
  const raw = await readJson<Omit<StoredDocumentRecord, "artifactPaths"> & { artifactPaths?: unknown }>(paths.documentJsonPath)
  return {
    ...raw,
    artifactPaths: paths,
  }
}

const isReusableRecord = async (
  record: StoredDocumentRecord,
  sourceStats: { sizeBytes: number; mtimeMs: number },
  paths: InternalDocumentArtifactPaths
): Promise<boolean> => {
  if (record.sizeBytes !== sourceStats.sizeBytes || record.mtimeMs !== sourceStats.mtimeMs) return false
  if (!await fileExists(paths.structureJsonPath)) return false
  for (let pageNumber = 1; pageNumber <= record.pageCount; pageNumber += 1) {
    const pagePath = path.join(paths.pagesDir, `${pageLabel(pageNumber)}.json`)
    if (!await fileExists(pagePath)) return false
  }
  return true
}

const writeJson = async (targetPath: string, data: unknown): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

const readSourceBytes = async (sourcePath: string): Promise<Uint8Array> => new Uint8Array(await readFile(sourcePath))

const matchesSourceSnapshot = (
  artifact: { sourceSizeBytes?: unknown; sourceMtimeMs?: unknown },
  record: StoredDocumentRecord
): boolean =>
  artifact.sourceSizeBytes === record.sizeBytes && artifact.sourceMtimeMs === record.mtimeMs

const matchesStrategyKey = (
  artifact: { strategyKey?: unknown },
  strategyKey: string
): boolean => artifact.strategyKey === strategyKey

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

const splitSemanticTextIntoChunks = (
  text: string,
  budget: { chunkMaxChars: number; chunkOverlapChars: number }
): string[] => {
  const normalized = text.trim()
  if (!normalized) return []
  if (normalized.length <= budget.chunkMaxChars) return [normalized]

  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    const idealEnd = Math.min(normalized.length, start + budget.chunkMaxChars)
    let end = idealEnd
    if (idealEnd < normalized.length) {
      const newlineBreak = normalized.lastIndexOf("\n", idealEnd)
      const sentenceBreak = normalized.lastIndexOf("。", idealEnd)
      const whitespaceBreak = normalized.lastIndexOf(" ", idealEnd)
      end = Math.max(newlineBreak, sentenceBreak, whitespaceBreak, start + Math.floor(budget.chunkMaxChars * 0.7))
      if (end <= start) end = idealEnd
    }
    const chunk = normalized.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= normalized.length) break
    start = Math.max(end - budget.chunkOverlapChars, start + 1)
  }
  return chunks
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
        type: "section" as const,
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

const buildSemanticPrompt = (
  pageNumber: number,
  chunkIndex: number,
  chunkText: string
): string => {
  return [
    "You extract heading/section candidates from one document text segment.",
    "Return JSON only.",
    "Schema:",
    "{",
    '  "candidates": [',
    "    {",
    '      "title": "string",',
    '      "level": 1,',
    '      "excerpt": "short evidence string",',
    "    }",
    "  ]",
    "}",
    "Rules:",
    "- Use only headings/sections that are clearly supported by the text segment.",
    "- Prefer conservative extraction over guessing.",
    "- Do not include page index entries, table rows, figure labels, or prose sentences.",
    "- Do not infer hierarchy beyond the explicit heading numbering or structure visible in the segment.",
    "- If no reliable semantic structure is detectable, return {\"candidates\":[]}.",
    `Page number: ${pageNumber}`,
    `Chunk index: ${chunkIndex}`,
    "",
    chunkText,
  ].join("\n")
}

const buildSemanticAggregationPrompt = (
  record: StoredDocumentRecord,
  candidates: ReadonlyArray<{
    title: string
    level: number
    pageNumber: number
    excerpt?: string
  }>
): string => {
  const candidateDump = JSON.stringify({ candidates }, null, 2)
  return [
    "You assemble semantic document structure from heading candidates.",
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
    "- Deduplicate repeated headings from overlapping segments.",
    "- Do not invent sections not present in the candidates.",
    "- If no reliable semantic structure is detectable, return {\"sections\":[]}.",
    `Document filename: ${record.filename}`,
    `Page count: ${record.pageCount}`,
    "",
    candidateDump,
  ].join("\n")
}

const buildHeuristicSemanticArtifact = (
  record: StoredDocumentRecord,
  artifactPath: string,
  sections: ReadonlyArray<LocalSemanticStructureNode>
): Omit<LocalSemanticDocumentStructure, "cacheStatus"> => ({
  documentId: record.documentId,
  generatedAt: new Date().toISOString(),
  detector: "heading-heuristic-v1",
  strategyKey: "heuristic::heading-heuristic-v1",
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

const ensureSemanticStructureArtifact = async (
  request: LocalSemanticDocumentRequest
): Promise<LocalSemanticDocumentStructure> => {
  const config = resolveConfig(request.config)
  const env = resolveEnv(request.env)
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
    ? `agent::agent-structured-v1::${provider}::${model}::${semanticBudget.pageSelection}::${semanticBudget.chunkMaxChars}::${semanticBudget.chunkOverlapChars}`
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
      const candidateMap = new Map<string, { title: string; level: number; pageNumber: number; excerpt?: string }>()
      for (const page of pages) {
        const chunks = splitSemanticTextIntoChunks(page.text, semanticBudget)
        for (const [chunkIndex, chunkText] of chunks.entries()) {
          const response = await generateText({
            config,
            env,
            providerAlias: provider,
            model,
            prompt: buildSemanticPrompt(page.pageNumber, chunkIndex + 1, chunkText),
            runtimeApiKeys: request.providerApiKeys,
          })
          const parsed = parseJsonObject(response) as { candidates?: Array<{ title?: unknown; level?: unknown; excerpt?: unknown }> }
          for (const candidate of Array.isArray(parsed?.candidates) ? parsed.candidates : []) {
            const title = typeof candidate?.title === "string" ? candidate.title.trim() : ""
            const level = typeof candidate?.level === "number" && Number.isInteger(candidate.level) && candidate.level > 0 ? candidate.level : 0
            if (!title || level <= 0) continue
            const key = `${page.pageNumber}:${level}:${title}`
            if (!candidateMap.has(key)) {
              candidateMap.set(key, {
                title,
                level,
                pageNumber: page.pageNumber,
                excerpt: typeof candidate?.excerpt === "string" ? candidate.excerpt.trim() : undefined,
              })
            }
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
    } catch {
      artifact = buildHeuristicSemanticArtifact(record, artifactPath, buildSemanticSectionTree(pages))
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

const ensurePageNumber = (pageCount: number, pageNumber: number): void => {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new Error(`pageNumber must be within 1..${pageCount}`)
  }
}

const resolveRenderScale = (config: EchoPdfConfig, requestedScale?: number): number => {
  if (typeof requestedScale === "number" && Number.isFinite(requestedScale) && requestedScale > 0) {
    return requestedScale
  }
  return config.service.defaultRenderScale
}

const indexDocumentInternal = async (
  request: LocalDocumentRequest
): Promise<{ record: StoredDocumentRecord; reused: boolean }> => {
  const config = resolveConfig(request.config)
  const sourcePath = path.resolve(process.cwd(), request.pdfPath)
  const workspaceDir = resolveWorkspaceDir(request.workspaceDir)
  const documentId = toDocumentId(sourcePath)
  const artifactPaths = buildArtifactPaths(workspaceDir, documentId)
  const sourceStats = await stat(sourcePath)
  const stored = await loadStoredDocument(artifactPaths)
  const sourceMeta = {
    sizeBytes: sourceStats.size,
    mtimeMs: sourceStats.mtimeMs,
  }

  if (!request.forceRefresh && stored && await isReusableRecord(stored, sourceMeta, artifactPaths)) {
    return { record: stored, reused: true }
  }

  await mkdir(artifactPaths.pagesDir, { recursive: true })
  const bytes = await readSourceBytes(sourcePath)
  const pageCount = await getLocalPdfPageCount(config, bytes)
  const pageNodes: LocalDocumentStructureNode[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const text = await extractLocalPdfPageText(config, bytes, pageNumber - 1)
    const preview = createPreview(text)
    const title = createPageTitle(pageNumber, text)
    const artifactPath = path.join(artifactPaths.pagesDir, `${pageLabel(pageNumber)}.json`)
    const pageArtifact: LocalPageContent = {
      documentId,
      pageNumber,
      title,
      preview,
      text,
      chars: text.length,
      artifactPath,
    }
    await writeJson(artifactPath, pageArtifact)
    pageNodes.push({
      id: `page-${pageNumber}`,
      type: "page",
      title,
      pageNumber,
      preview,
      artifactPath,
    })
  }

  const structure: LocalDocumentStructure = {
    documentId,
    generatedAt: new Date().toISOString(),
    root: {
      id: documentId,
      type: "document",
      title: path.basename(sourcePath),
      children: pageNodes,
    },
  }
  await writeJson(artifactPaths.structureJsonPath, structure)

  const documentRecord: StoredDocumentRecord = {
    documentId,
    sourcePath,
    filename: path.basename(sourcePath),
    sizeBytes: sourceMeta.sizeBytes,
    mtimeMs: sourceMeta.mtimeMs,
    pageCount,
    indexedAt: structure.generatedAt,
    artifactPaths,
  }
  await writeJson(artifactPaths.documentJsonPath, {
    ...documentRecord,
    artifactPaths: toPublicArtifactPaths(documentRecord.artifactPaths),
  })
  return { record: documentRecord, reused: false }
}

const toMetadata = (
  record: StoredDocumentRecord,
  cacheStatus: "fresh" | "reused"
): LocalDocumentMetadata => ({
  ...record,
  artifactPaths: toPublicArtifactPaths(record.artifactPaths),
  cacheStatus,
})

const ensureRenderArtifact = async (request: LocalPageRenderRequest): Promise<LocalPageRenderArtifact> => {
  const config = resolveConfig(request.config)
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)

  const renderScale = resolveRenderScale(config, request.renderScale)
  const renderPaths = buildRenderArtifactPaths(record.artifactPaths, request.pageNumber, renderScale)
  if (!request.forceRefresh && await fileExists(renderPaths.artifactPath) && await fileExists(renderPaths.imagePath)) {
    const cached = await readJson<Omit<LocalPageRenderArtifact, "cacheStatus"> & { cacheStatus?: unknown }>(renderPaths.artifactPath)
    if (matchesSourceSnapshot(cached, record)) {
      return {
        ...cached,
        cacheStatus: "reused",
      }
    }
  }

  const bytes = await readSourceBytes(record.sourcePath)
  const rendered = await renderLocalPdfPageToPng(config, bytes, request.pageNumber - 1, renderScale)
  await mkdir(path.dirname(renderPaths.imagePath), { recursive: true })
  await writeFile(renderPaths.imagePath, rendered.png)

  const artifact: Omit<LocalPageRenderArtifact, "cacheStatus"> = {
    documentId: record.documentId,
    pageNumber: request.pageNumber,
    renderScale,
    sourceSizeBytes: record.sizeBytes,
    sourceMtimeMs: record.mtimeMs,
    width: rendered.width,
    height: rendered.height,
    mimeType: "image/png",
    imagePath: renderPaths.imagePath,
    artifactPath: renderPaths.artifactPath,
    generatedAt: new Date().toISOString(),
  }
  await writeJson(renderPaths.artifactPath, artifact)
  return {
    ...artifact,
    cacheStatus: "fresh",
  }
}

export const get_document = async (request: LocalDocumentRequest): Promise<LocalDocumentMetadata> => {
  const { record, reused } = await indexDocumentInternal(request)
  return toMetadata(record, reused ? "reused" : "fresh")
}

export const get_document_structure = async (request: LocalDocumentRequest): Promise<LocalDocumentStructure> => {
  const { record } = await indexDocumentInternal(request)
  return readJson<LocalDocumentStructure>(record.artifactPaths.structureJsonPath)
}

export const get_semantic_document_structure = async (
  request: LocalSemanticDocumentRequest
): Promise<LocalSemanticDocumentStructure> => ensureSemanticStructureArtifact(request)

export const get_page_content = async (request: LocalPageContentRequest): Promise<LocalPageContent> => {
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)
  const pagePath = path.join(record.artifactPaths.pagesDir, `${pageLabel(request.pageNumber)}.json`)
  return readJson<LocalPageContent>(pagePath)
}

export const get_page_render = async (request: LocalPageRenderRequest): Promise<LocalPageRenderArtifact> =>
  ensureRenderArtifact(request)

const getPageOcrMigrationOnly = async (request: LocalPageOcrRequest): Promise<LocalPageOcrArtifact> => {
  const config = resolveConfig(request.config)
  const env = resolveEnv(request.env)
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)

  const renderArtifact = await ensureRenderArtifact(request)
  const provider = resolveProviderAlias(config, request.provider)
  const model = resolveModelForProvider(config, provider, request.model)
  if (!model) {
    throw new Error("model is required for local OCR artifacts; pass `model` or set agent.defaultModel")
  }
  const prompt = request.prompt?.trim() || config.agent.ocrPrompt
  const artifactPath = buildOcrArtifactPath(
    record.artifactPaths,
    request.pageNumber,
    renderArtifact.renderScale,
    provider,
    model,
    prompt
  )

  if (!request.forceRefresh && await fileExists(artifactPath)) {
    const cached = await readJson<Omit<LocalPageOcrArtifact, "cacheStatus"> & { cacheStatus?: unknown }>(artifactPath)
    if (matchesSourceSnapshot(cached, record)) {
      return {
        ...cached,
        cacheStatus: "reused",
      }
    }
  }

  const imageBytes = new Uint8Array(await readFile(renderArtifact.imagePath))
  const imageDataUrl = toDataUrl(imageBytes, renderArtifact.mimeType)
  const fallbackText = (await get_page_content(request)).text
  const recognized = await visionRecognize({
    config,
    env,
    providerAlias: provider,
    model,
    prompt,
    imageDataUrl,
    runtimeApiKeys: request.providerApiKeys,
  })
  const text = stripCodeFences(recognized || fallbackText || "")

  const artifact: Omit<LocalPageOcrArtifact, "cacheStatus"> = {
    documentId: record.documentId,
    pageNumber: request.pageNumber,
    renderScale: renderArtifact.renderScale,
    sourceSizeBytes: record.sizeBytes,
    sourceMtimeMs: record.mtimeMs,
    provider,
    model,
    prompt,
    text,
    chars: text.length,
    imagePath: renderArtifact.imagePath,
    renderArtifactPath: renderArtifact.artifactPath,
    artifactPath,
    generatedAt: new Date().toISOString(),
  }
  await writeJson(artifactPath, artifact)
  return {
    ...artifact,
    cacheStatus: "fresh",
  }
}
