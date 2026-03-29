/// <reference path="../node/compat.d.ts" />

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveModelForProvider, resolveProviderAlias } from "../agent-defaults.js"
import { toDataUrl } from "../file-utils.js"
import { visionRecognize } from "../provider-client.js"
import { extractLocalPdfPageText, getLocalPdfPageCount, renderLocalPdfPageToPng } from "../node/pdfium-local.js"
import type {
  LocalDocumentMetadata,
  LocalDocumentRequest,
  LocalDocumentStructure,
  LocalDocumentStructureNode,
  LocalPageContent,
  LocalPageContentRequest,
  LocalPageOcrArtifact,
  LocalPageOcrRequest,
  LocalPageRenderArtifact,
  LocalPageRenderRequest,
  StoredDocumentRecord,
} from "./types.js"
import {
  buildArtifactPaths,
  buildOcrArtifactPath,
  buildRenderArtifactPaths,
  createPageTitle,
  createPreview,
  ensurePageNumber,
  fileExists,
  isReusableRecord,
  loadStoredDocument,
  matchesSourceSnapshot,
  pageLabel,
  readJson,
  readSourceBytes,
  resolveConfig,
  resolveEnv,
  resolveRenderScale,
  resolveWorkspaceDir,
  toDocumentId,
  toPublicArtifactPaths,
  writeJson,
} from "./shared.js"

export const indexDocumentInternal = async (
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

export const ensureRenderArtifact = async (request: LocalPageRenderRequest): Promise<LocalPageRenderArtifact> => {
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

export const get_page_content = async (request: LocalPageContentRequest): Promise<LocalPageContent> => {
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)
  const pagePath = path.join(record.artifactPaths.pagesDir, `${pageLabel(request.pageNumber)}.json`)
  return readJson<LocalPageContent>(pagePath)
}

export const get_page_render = async (request: LocalPageRenderRequest): Promise<LocalPageRenderArtifact> =>
  ensureRenderArtifact(request)

export const getPageOcrMigrationOnly = async (request: LocalPageOcrRequest): Promise<LocalPageOcrArtifact> => {
  const env = resolveEnv(request.env)
  const config = resolveConfig(request.config, env)
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
  const text = recognized.trim() || fallbackText || ""

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
