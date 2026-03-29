/// <reference path="../node/compat.d.ts" />

import type { EchoPdfConfig } from "../pdf-types.js"
import type { Env } from "../types.js"

export interface LocalDocumentArtifactPaths {
  readonly workspaceDir: string
  readonly documentDir: string
  readonly documentJsonPath: string
  readonly structureJsonPath: string
  readonly semanticStructureJsonPath: string
  readonly pagesDir: string
  readonly rendersDir: string
}

export interface InternalDocumentArtifactPaths extends LocalDocumentArtifactPaths {
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
  readonly fallback?: {
    readonly from: "agent-structured-v1"
    readonly to: "heading-heuristic-v1"
    readonly reason: string
  }
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

export interface LocalTableArtifactItem {
  readonly id: string
  readonly latexTabular: string
  readonly caption?: string
  readonly evidenceText?: string
}

export interface LocalFormulaArtifactItem {
  readonly id: string
  readonly latexMath: string
  readonly label?: string
  readonly evidenceText?: string
}

export interface LocalPageTablesArtifact {
  readonly documentId: string
  readonly pageNumber: number
  readonly renderScale: number
  readonly sourceSizeBytes: number
  readonly sourceMtimeMs: number
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly imagePath: string
  readonly pageArtifactPath: string
  readonly renderArtifactPath: string
  readonly artifactPath: string
  readonly generatedAt: string
  readonly tables: ReadonlyArray<LocalTableArtifactItem>
  readonly cacheStatus: "fresh" | "reused"
}

export interface LocalPageFormulasArtifact {
  readonly documentId: string
  readonly pageNumber: number
  readonly renderScale: number
  readonly sourceSizeBytes: number
  readonly sourceMtimeMs: number
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly imagePath: string
  readonly pageArtifactPath: string
  readonly renderArtifactPath: string
  readonly artifactPath: string
  readonly generatedAt: string
  readonly formulas: ReadonlyArray<LocalFormulaArtifactItem>
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

export interface LocalPageTablesRequest extends LocalPageRenderRequest {
  readonly provider?: string
  readonly model?: string
  readonly prompt?: string
  readonly env?: Env
  readonly providerApiKeys?: Record<string, string>
}

export interface LocalPageFormulasRequest extends LocalPageRenderRequest {
  readonly provider?: string
  readonly model?: string
  readonly prompt?: string
  readonly env?: Env
  readonly providerApiKeys?: Record<string, string>
}

export interface LocalPageOcrRequest extends LocalPageRenderRequest {
  readonly provider?: string
  readonly model?: string
  readonly prompt?: string
  readonly env?: Env
  readonly providerApiKeys?: Record<string, string>
}

export interface StoredDocumentRecord {
  readonly documentId: string
  readonly sourcePath: string
  readonly filename: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly pageCount: number
  readonly indexedAt: string
  readonly artifactPaths: InternalDocumentArtifactPaths
}

export type SemanticAgentCandidate = {
  title: string
  level: number
  pageNumber: number
  excerpt?: string
  confidence: number
}
