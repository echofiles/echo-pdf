/// <reference path="../node/compat.d.ts" />

import { readFile } from "node:fs/promises"
import path from "node:path"
import { toDataUrl } from "../file-utils.js"
import { visionRecognize } from "../provider-client.js"
import type { Env } from "../types.js"
import { ensureRenderArtifact, indexDocumentInternal } from "./document.js"
import {
  buildStructuredArtifactPath,
  ensurePageNumber,
  fileExists,
  matchesSourceSnapshot,
  normalizeTableItems,
  pageLabel,
  parseJsonObject,
  readJson,
  resolveAgentSelection,
  resolveConfig,
  resolveEnv,
  resolveRenderScale,
  writeJson,
} from "./shared.js"
import type {
  LocalPageTablesArtifact,
  LocalPageTablesRequest,
} from "./types.js"

const DEFAULT_TABLE_PROMPT =
  "Detect all tabular structures from this PDF page image. " +
  "Return JSON only. Schema: " +
  '{ "tables": [{ "latexTabular": "\\\\begin{tabular}...\\\\end{tabular}", "caption": "optional", "evidenceText": "optional" }] }. ' +
  "Each table must be a complete LaTeX tabular environment. " +
  "If no tables are found, return {\"tables\":[]}."

export const get_page_tables_latex = async (
  request: LocalPageTablesRequest
): Promise<LocalPageTablesArtifact> => {
  const env = resolveEnv(request.env)
  const config = resolveConfig(request.config, env)
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)

  const { provider, model } = resolveAgentSelection(config, request)
  const renderScale = resolveRenderScale(config, request.renderScale)
  const prompt = typeof request.prompt === "string" && request.prompt.trim().length > 0
    ? request.prompt.trim()
    : (config.agent.tablePrompt || DEFAULT_TABLE_PROMPT)

  const tablesDir = path.join(record.artifactPaths.documentDir, "tables")
  const artifactPath = buildStructuredArtifactPath(tablesDir, request.pageNumber, renderScale, provider, model, prompt)

  if (!request.forceRefresh && await fileExists(artifactPath)) {
    const cached = await readJson<Omit<LocalPageTablesArtifact, "cacheStatus"> & { cacheStatus?: unknown }>(artifactPath)
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

  const parsed = parseJsonObject(response) as { tables?: unknown }
  const tables = normalizeTableItems(parsed?.tables)

  const pageArtifactPath = path.join(record.artifactPaths.pagesDir, `${pageLabel(request.pageNumber)}.json`)
  const artifact: Omit<LocalPageTablesArtifact, "cacheStatus"> = {
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
  }

  await writeJson(artifactPath, artifact)
  return { ...artifact, cacheStatus: "fresh" }
}
