import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveModelForProvider, resolveProviderAlias } from "../agent-defaults.js"
import { loadEchoPdfConfig } from "../pdf-config.js"
import type { EchoPdfConfig } from "../pdf-types.js"
import type { Env } from "../types.js"
import type {
  InternalDocumentArtifactPaths,
  LocalDocumentArtifactPaths,
  LocalFormulaArtifactItem,
  LocalTableArtifactItem,
  StoredDocumentRecord,
} from "./types.js"

export const defaultWorkspaceDir = (): string => path.resolve(process.cwd(), ".echo-pdf-workspace")

export const resolveWorkspaceDir = (workspaceDir?: string): string =>
  path.resolve(process.cwd(), workspaceDir?.trim() || defaultWorkspaceDir())

export const toDocumentId = (absolutePdfPath: string): string =>
  createHash("sha256").update(absolutePdfPath).digest("hex").slice(0, 16)

export const hashFragment = (value: string, length = 12): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length)

export const sanitizeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "_")

export const scaleLabel = (value: number): string => sanitizeSegment(String(value))

export const pageLabel = (pageNumber: number): string => String(pageNumber).padStart(4, "0")

export const buildArtifactPaths = (workspaceDir: string, documentId: string): InternalDocumentArtifactPaths => {
  const documentDir = path.join(workspaceDir, "documents", documentId)
  return {
    workspaceDir,
    documentDir,
    documentJsonPath: path.join(documentDir, "document.json"),
    structureJsonPath: path.join(documentDir, "structure.json"),
    semanticStructureJsonPath: path.join(documentDir, "semantic-structure.json"),
    pagesDir: path.join(documentDir, "pages"),
    rendersDir: path.join(documentDir, "renders"),
  }
}

export const toPublicArtifactPaths = (paths: InternalDocumentArtifactPaths): LocalDocumentArtifactPaths => ({
  workspaceDir: paths.workspaceDir,
  documentDir: paths.documentDir,
  documentJsonPath: paths.documentJsonPath,
  structureJsonPath: paths.structureJsonPath,
  semanticStructureJsonPath: paths.semanticStructureJsonPath,
  pagesDir: paths.pagesDir,
  rendersDir: paths.rendersDir,
})

export const buildRenderArtifactPaths = (
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

export const buildStructuredArtifactPath = (
  baseDir: string,
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
  return path.join(baseDir, `${key}.json`)
}

export const createPreview = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 160)

export const createPageTitle = (pageNumber: number, text: string): string => {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? `Page ${pageNumber}: ${firstLine.slice(0, 80)}` : `Page ${pageNumber}`
}

export const stripCodeFences = (value: string): string => {
  const text = value.trim()
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return typeof fenced?.[1] === "string" ? fenced[1].trim() : text
}

export const parseJsonObject = (value: string): unknown => {
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
    throw new Error("model output was not valid JSON")
  }
}

export const normalizeTableItems = (value: unknown): LocalTableArtifactItem[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const table = item as {
      latexTabular?: unknown
      caption?: unknown
      evidenceText?: unknown
    }
    const latexTabular = typeof table.latexTabular === "string" ? stripCodeFences(table.latexTabular).trim() : ""
    if (!latexTabular.includes("\\begin{tabular}") || !latexTabular.includes("\\end{tabular}")) return []
    return [{
      id: `table-${index + 1}`,
      latexTabular,
      caption: typeof table.caption === "string" ? table.caption.trim() : undefined,
      evidenceText: typeof table.evidenceText === "string" ? table.evidenceText.trim() : undefined,
    }]
  })
}

export const normalizeFormulaItems = (value: unknown): LocalFormulaArtifactItem[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const formula = item as {
      latexMath?: unknown
      label?: unknown
      evidenceText?: unknown
    }
    const latexMath = typeof formula.latexMath === "string" ? stripCodeFences(formula.latexMath).trim() : ""
    if (!latexMath) return []
    return [{
      id: `formula-${index + 1}`,
      latexMath,
      label: typeof formula.label === "string" ? formula.label.trim() : undefined,
      evidenceText: typeof formula.evidenceText === "string" ? formula.evidenceText.trim() : undefined,
    }]
  })
}

export const resolveEnv = (env?: Env): Env => env ?? (process.env as unknown as Env)

export const resolveConfig = (config?: EchoPdfConfig, env?: Env): EchoPdfConfig => config ?? loadEchoPdfConfig(resolveEnv(env))

export const resolveAgentSelection = (
  config: EchoPdfConfig,
  input: { provider?: string; model?: string }
): { provider: string; model: string } => {
  const provider = resolveProviderAlias(config, input.provider)
  const model = resolveModelForProvider(config, provider, input.model)
  if (!model) {
    throw new Error(`model is required for VL-first structured artifacts; pass \`model\` or set agent.defaultModel for provider "${provider}"`)
  }
  return { provider, model }
}

export const resolveRenderScale = (config: EchoPdfConfig, requestedScale?: number): number => {
  if (typeof requestedScale === "number" && Number.isFinite(requestedScale) && requestedScale > 0) {
    return requestedScale
  }
  return config.service.defaultRenderScale
}

export const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

export const readJson = async <T>(targetPath: string): Promise<T> => {
  const raw = await readFile(targetPath, "utf-8")
  return JSON.parse(raw) as T
}

export const loadStoredDocument = async (paths: InternalDocumentArtifactPaths): Promise<StoredDocumentRecord | null> => {
  if (!await fileExists(paths.documentJsonPath)) return null
  const raw = await readJson<Omit<StoredDocumentRecord, "artifactPaths"> & { artifactPaths?: unknown }>(paths.documentJsonPath)
  return {
    ...raw,
    artifactPaths: paths,
  }
}

export const isReusableRecord = async (
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

export const writeJson = async (targetPath: string, data: unknown): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

export const readSourceBytes = async (sourcePath: string): Promise<Uint8Array> => new Uint8Array(await readFile(sourcePath))

export const matchesSourceSnapshot = (
  artifact: { sourceSizeBytes?: unknown; sourceMtimeMs?: unknown },
  record: StoredDocumentRecord
): boolean =>
  artifact.sourceSizeBytes === record.sizeBytes && artifact.sourceMtimeMs === record.mtimeMs

export const matchesStrategyKey = (
  artifact: { strategyKey?: unknown },
  strategyKey: string
): boolean => artifact.strategyKey === strategyKey

export const ensurePageNumber = (pageCount: number, pageNumber: number): void => {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new Error(`pageNumber must be within 1..${pageCount}`)
  }
}
