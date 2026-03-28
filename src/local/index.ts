/// <reference path="../node/compat.d.ts" />

import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveModelForProvider, resolveProviderAlias } from "../agent-defaults.js"
import { toDataUrl } from "../file-utils.js"
import { loadEchoPdfConfig } from "../pdf-config.js"
import { visionRecognize } from "../provider-client.js"
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
  readonly detector: "heading-heuristic-v1"
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

export interface LocalPageOcrArtifact {
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

export interface LocalPageRenderRequest extends LocalPageContentRequest {
  readonly renderScale?: number
}

export interface LocalPageOcrRequest extends LocalPageRenderRequest {
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
  readonly artifactPaths: LocalDocumentArtifactPaths
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

const buildArtifactPaths = (workspaceDir: string, documentId: string): LocalDocumentArtifactPaths => {
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
  paths: LocalDocumentArtifactPaths,
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

const loadStoredDocument = async (paths: LocalDocumentArtifactPaths): Promise<StoredDocumentRecord | null> => {
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
  paths: LocalDocumentArtifactPaths
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

const ensureSemanticStructureArtifact = async (
  request: LocalDocumentRequest
): Promise<LocalSemanticDocumentStructure> => {
  const { record } = await indexDocumentInternal(request)
  const artifactPath = record.artifactPaths.semanticStructureJsonPath
  if (!request.forceRefresh && await fileExists(artifactPath)) {
    const cached = await readJson<LocalSemanticDocumentStructure>(artifactPath)
    if (matchesSourceSnapshot(cached, record)) {
      return {
        ...cached,
        cacheStatus: "reused",
      }
    }
  }

  const pages: Array<{ pageNumber: number; text: string; artifactPath: string }> = []
  for (let pageNumber = 1; pageNumber <= record.pageCount; pageNumber += 1) {
    const pagePath = path.join(record.artifactPaths.pagesDir, `${pageLabel(pageNumber)}.json`)
    const page = await readJson<LocalPageContent>(pagePath)
    pages.push({
      pageNumber,
      text: page.text,
      artifactPath: page.artifactPath,
    })
  }

  const sections = buildSemanticSectionTree(pages)
  const artifact: Omit<LocalSemanticDocumentStructure, "cacheStatus"> = {
    documentId: record.documentId,
    generatedAt: new Date().toISOString(),
    detector: "heading-heuristic-v1",
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
  await writeJson(artifactPaths.documentJsonPath, documentRecord)
  return { record: documentRecord, reused: false }
}

const toMetadata = (
  record: StoredDocumentRecord,
  cacheStatus: "fresh" | "reused"
): LocalDocumentMetadata => ({
  ...record,
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
  request: LocalDocumentRequest
): Promise<LocalSemanticDocumentStructure> => ensureSemanticStructureArtifact(request)

export const get_page_content = async (request: LocalPageContentRequest): Promise<LocalPageContent> => {
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)
  const pagePath = path.join(record.artifactPaths.pagesDir, `${pageLabel(request.pageNumber)}.json`)
  return readJson<LocalPageContent>(pagePath)
}

export const get_page_render = async (request: LocalPageRenderRequest): Promise<LocalPageRenderArtifact> =>
  ensureRenderArtifact(request)

export const get_page_ocr = async (request: LocalPageOcrRequest): Promise<LocalPageOcrArtifact> => {
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
