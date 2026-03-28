/// <reference path="../node/compat.d.ts" />

import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { extractLocalPdfPageText, getLocalPdfPageCount } from "../node/pdfium-local.js"
import { loadEchoPdfConfig } from "../pdf-config.js"
import type { EchoPdfConfig } from "../pdf-types.js"

export interface LocalDocumentArtifactPaths {
  readonly workspaceDir: string
  readonly documentDir: string
  readonly documentJsonPath: string
  readonly structureJsonPath: string
  readonly pagesDir: string
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

export interface LocalPageContent {
  readonly documentId: string
  readonly pageNumber: number
  readonly title: string
  readonly preview: string
  readonly text: string
  readonly chars: number
  readonly artifactPath: string
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

const buildArtifactPaths = (workspaceDir: string, documentId: string): LocalDocumentArtifactPaths => {
  const documentDir = path.join(workspaceDir, "documents", documentId)
  return {
    workspaceDir,
    documentDir,
    documentJsonPath: path.join(documentDir, "document.json"),
    structureJsonPath: path.join(documentDir, "structure.json"),
    pagesDir: path.join(documentDir, "pages"),
  }
}

const createPreview = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 160)

const createPageTitle = (pageNumber: number, text: string): string => {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? `Page ${pageNumber}: ${firstLine.slice(0, 80)}` : `Page ${pageNumber}`
}

const resolveConfig = (config?: EchoPdfConfig): EchoPdfConfig => config ?? loadEchoPdfConfig({} as never)

const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

const loadStoredDocument = async (paths: LocalDocumentArtifactPaths): Promise<StoredDocumentRecord | null> => {
  if (!await fileExists(paths.documentJsonPath)) return null
  const raw = await readFile(paths.documentJsonPath, "utf-8")
  return JSON.parse(raw) as StoredDocumentRecord
}

const isReusableRecord = async (
  record: StoredDocumentRecord,
  sourceStats: { sizeBytes: number; mtimeMs: number },
  paths: LocalDocumentArtifactPaths
): Promise<boolean> => {
  if (record.sizeBytes !== sourceStats.sizeBytes || record.mtimeMs !== sourceStats.mtimeMs) return false
  if (!await fileExists(paths.structureJsonPath)) return false
  for (let pageNumber = 1; pageNumber <= record.pageCount; pageNumber += 1) {
    const pagePath = path.join(paths.pagesDir, `${String(pageNumber).padStart(4, "0")}.json`)
    if (!await fileExists(pagePath)) return false
  }
  return true
}

const writeJson = async (targetPath: string, data: unknown): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

const indexDocumentInternal = async (
  request: LocalDocumentRequest
): Promise<{ record: StoredDocumentRecord; reused: boolean }> => {
  const config = resolveConfig(request.config)
  const sourcePath = path.resolve(process.cwd(), request.pdfPath)
  const workspaceDir = resolveWorkspaceDir(request.workspaceDir)
  const documentId = toDocumentId(sourcePath)
  const artifactPaths = buildArtifactPaths(workspaceDir, documentId)
  const sourceFile = await readFile(sourcePath)
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
  const bytes = new Uint8Array(sourceFile)
  const pageCount = await getLocalPdfPageCount(config, bytes)
  const pageNodes: LocalDocumentStructureNode[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const text = await extractLocalPdfPageText(config, bytes, pageNumber - 1)
    const preview = createPreview(text)
    const title = createPageTitle(pageNumber, text)
    const artifactPath = path.join(artifactPaths.pagesDir, `${String(pageNumber).padStart(4, "0")}.json`)
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

export const get_document = async (request: LocalDocumentRequest): Promise<LocalDocumentMetadata> => {
  const { record, reused } = await indexDocumentInternal(request)
  return toMetadata(record, reused ? "reused" : "fresh")
}

export const get_document_structure = async (request: LocalDocumentRequest): Promise<LocalDocumentStructure> => {
  const { record } = await indexDocumentInternal(request)
  const raw = await readFile(record.artifactPaths.structureJsonPath, "utf-8")
  return JSON.parse(raw) as LocalDocumentStructure
}

export const get_page_content = async (request: LocalPageContentRequest): Promise<LocalPageContent> => {
  const { record } = await indexDocumentInternal(request)
  if (!Number.isInteger(request.pageNumber) || request.pageNumber < 1 || request.pageNumber > record.pageCount) {
    throw new Error(`pageNumber must be within 1..${record.pageCount}`)
  }
  const pagePath = path.join(record.artifactPaths.pagesDir, `${String(request.pageNumber).padStart(4, "0")}.json`)
  const raw = await readFile(pagePath, "utf-8")
  return JSON.parse(raw) as LocalPageContent
}
