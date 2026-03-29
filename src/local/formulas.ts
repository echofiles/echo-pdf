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
  normalizeFormulaItems,
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
  LocalPageFormulasArtifact,
  LocalPageFormulasRequest,
} from "./types.js"

const DEFAULT_FORMULA_PROMPT =
  "Detect all displayed mathematical formulas from this PDF page image. " +
  "Return JSON only. Schema: " +
  '{ "formulas": [{ "latexMath": "LaTeX math expression", "label": "optional equation label", "evidenceText": "optional" }] }. ' +
  "Use LaTeX math notation. Do not include inline prose math or trivial single-symbol expressions. " +
  "If no displayed formulas are found, return {\"formulas\":[]}."

export const get_page_formulas_latex = async (
  request: LocalPageFormulasRequest
): Promise<LocalPageFormulasArtifact> => {
  const env = resolveEnv(request.env)
  const config = resolveConfig(request.config, env)
  const { record } = await indexDocumentInternal(request)
  ensurePageNumber(record.pageCount, request.pageNumber)

  const { provider, model } = resolveAgentSelection(config, request)
  const renderScale = resolveRenderScale(config, request.renderScale)
  const prompt = typeof request.prompt === "string" && request.prompt.trim().length > 0
    ? request.prompt.trim()
    : DEFAULT_FORMULA_PROMPT

  const formulasDir = path.join(record.artifactPaths.documentDir, "formulas")
  const artifactPath = buildStructuredArtifactPath(formulasDir, request.pageNumber, renderScale, provider, model, prompt)

  if (!request.forceRefresh && await fileExists(artifactPath)) {
    const cached = await readJson<Omit<LocalPageFormulasArtifact, "cacheStatus"> & { cacheStatus?: unknown }>(artifactPath)
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

  const parsed = parseJsonObject(response) as { formulas?: unknown }
  const formulas = normalizeFormulaItems(parsed?.formulas)

  const pageArtifactPath = path.join(record.artifactPaths.pagesDir, `${pageLabel(request.pageNumber)}.json`)
  const artifact: Omit<LocalPageFormulasArtifact, "cacheStatus"> = {
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
    formulas,
  }

  await writeJson(artifactPath, artifact)
  return { ...artifact, cacheStatus: "fresh" }
}
