import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const repoRoot = path.resolve(__dirname, "..")
export const samplesRoot = __dirname
export const repoOwnedSamplesDir = path.join(samplesRoot, "repo-owned")
export const publicSampleCacheDir = path.join(samplesRoot, "public-cache")
export const publicSampleRegistryPath = path.join(samplesRoot, "public-sources.json")

export const repoOwnedSamplePaths = {
  smokePdf: path.join(repoOwnedSamplesDir, "smoke.pdf"),
  inputPdf: path.join(repoOwnedSamplesDir, "input.pdf"),
}

export const publicSamplePaths = {
  attentionPaperPdf: path.join(publicSampleCacheDir, "arxiv-attention-is-all-you-need.pdf"),
  irsFormW4Pdf: path.join(publicSampleCacheDir, "irs-form-w4.pdf"),
  irsPublication15TPdf: path.join(publicSampleCacheDir, "irs-publication-15t.pdf"),
  cisaIrpfPdf: path.join(publicSampleCacheDir, "cisa-infrastructure-resilience-planning-framework.pdf"),
  nist171r2Pdf: path.join(publicSampleCacheDir, "nist-sp-800-171r2.pdf"),
}
