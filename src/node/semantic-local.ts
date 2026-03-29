export interface SemanticPageInput {
  readonly pageNumber: number
  readonly text: string
  readonly artifactPath: string
}

export interface SemanticSectionNode {
  readonly id: string
  readonly type: "section"
  readonly title: string
  readonly level: number
  readonly pageNumber: number
  readonly pageArtifactPath: string
  readonly excerpt: string
  readonly children: ReadonlyArray<SemanticSectionNode>
}

interface MutableSemanticSectionNode {
  readonly id: string
  readonly type: "section"
  readonly title: string
  readonly level: number
  readonly pageNumber: number
  readonly pageArtifactPath: string
  readonly excerpt: string
  readonly children: MutableSemanticSectionNode[]
}

interface HeadingCandidate {
  readonly title: string
  readonly level: number
  readonly pageNumber: number
  readonly pageArtifactPath: string
  readonly excerpt: string
}

const normalizeLine = (value: string): string => value.replace(/\s+/g, " ").trim()

const excerptFor = (value: string): string => normalizeLine(value).slice(0, 160)

const hasTocSuffix = (value: string): boolean => /(?:\.{2,}|\s{2,}|\t)\d+$/.test(value)
const hasTrailingPageNumber = (value: string): boolean => /\s\d+$/.test(value)
const sentenceTerminal = /[.!?。；;：:]$/
const headingStopwords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "if",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "otherwise",
  "the",
  "to",
  "unless",
  "with",
])

const isContentsHeading = (value: string): boolean => {
  const normalized = normalizeLine(value).toLowerCase()
  return normalized === "contents" || normalized === "table of contents" || normalized === "目录"
}

const hasStrongHeadingText = (value: string): boolean =>
  /[A-Za-z]{3,}/.test(value) || /[\u4E00-\u9FFF]{2,}/.test(value)

const isShortAllCapsLabel = (value: string): boolean => {
  const normalized = normalizeLine(value)
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean)
  if (tokens.length !== 1) return false
  const [token] = tokens
  if (!token) return false
  return token.length <= 4 && /^[A-Z]+$/.test(token)
}

const isMeasurementLikeFragment = (value: string): boolean => {
  const normalized = normalizeLine(value)
  if (!normalized) return false
  if (hasStrongHeadingText(normalized)) return false
  return /\d/.test(normalized)
}

const isTableHeaderLike = (value: string): boolean => {
  const normalized = normalizeLine(value)
  const alphaTokens = normalized.split(/\s+/).filter((token) => /[A-Za-z]/.test(token))
  if (alphaTokens.length < 4) return false
  const lowerCaseCount = alphaTokens.filter((token) => /[a-z]/.test(token)).length
  const tableSignals = alphaTokens.filter((token) => /\(\d+\)|[A-Z]{3,}/.test(token)).length
  return lowerCaseCount === 0 && tableSignals >= 3
}

const isRepeatingLabelLike = (value: string): boolean => {
  const normalized = normalizeLine(value)
  const alphaTokens = normalized
    .split(/\s+/)
    .filter((token) => /[A-Za-z]/.test(token))
    .map((token) => token.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean)
  if (alphaTokens.length < 2) return false
  if (alphaTokens.some((token) => /[a-z]/.test(token))) return false
  const uniqueTokenCount = new Set(alphaTokens).size
  return uniqueTokenCount < alphaTokens.length
}

const isSentenceLike = (value: string): boolean => {
  const normalized = normalizeLine(value)
  if (!normalized) return false
  const lower = normalized.toLowerCase()
  const tokens = lower.split(/\s+/).filter(Boolean)
  const stopwordCount = tokens.filter((token) => headingStopwords.has(token)).length
  if (sentenceTerminal.test(normalized) && tokens.length >= 3) return true
  return tokens.length >= 7 && stopwordCount / tokens.length >= 0.35
}

const detectHeading = (line: string): { title: string; level: number } | null => {
  const normalized = normalizeLine(line)
  if (!normalized || normalized.length > 120) return null
  if (hasTocSuffix(normalized)) return null

  const numbered = normalized.match(/^(\d+(?:\.\d+){0,3})\s+(.+)$/)
  if (numbered) {
    const numberPath = numbered[1] || ""
    const topLevelNumber = Number.parseInt(numberPath.split(".")[0] || "", 10)
    const title = normalizeLine(numbered[2] || "")
    const level = numberPath.split(".").length
    if (!title) return null
    if (title.length < 2) return null
    if (hasTrailingPageNumber(normalized)) return null
    if (!/^[A-Za-z\u4E00-\u9FFF第（(]/.test(title)) return null
    if (/^(GHz|MHz|Kbps|Mbps|Hz|kHz|mA|V|W)\b/i.test(title)) return null
    if (sentenceTerminal.test(title)) return null
    if (Number.isFinite(topLevelNumber) && topLevelNumber > 20) return null
    if (/^[A-Z]+\d+$/.test(title)) return null
    if (level === 1 && title.length > 40) return null
    if (level === 1 && /[，,×—]/.test(title)) return null
    if (!hasStrongHeadingText(title)) return null
    if (topLevelNumber === 0 && isShortAllCapsLabel(title)) return null
    if (isMeasurementLikeFragment(title)) return null
    if (isSentenceLike(title)) return null
    if (isTableHeaderLike(title)) return null
    if (isRepeatingLabelLike(title)) return null
    return {
      title: `${numberPath} ${title}`.trim(),
      level,
    }
  }

  const chinese = normalized.match(/^(第[0-9一二三四五六七八九十百]+)(章|节|部分)\s+(.+)$/)
  if (chinese) {
    const suffix = chinese[2] || ""
    return {
      title: normalized,
      level: suffix === "节" ? 2 : 1,
    }
  }

  const english = normalized.match(/^(Chapter|Section|Part|Appendix)\b[:\s-]*(.+)?$/i)
  if (english) {
    const tail = normalizeLine(english[2] || "")
    if (!tail) return null
    if (!/^[A-Z0-9(IVX第]/.test(tail)) return null
    if (!hasStrongHeadingText(tail)) return null
    if (isSentenceLike(tail)) return null
    if (isTableHeaderLike(normalized)) return null
    if (isRepeatingLabelLike(tail)) return null
    return {
      title: normalized,
      level: /section/i.test(english[1] || "") ? 2 : 1,
    }
  }

  return null
}

const toReadonlyTree = (node: MutableSemanticSectionNode): SemanticSectionNode => ({
  ...node,
  children: node.children.map(toReadonlyTree),
})

export const buildSemanticSectionTree = (
  pages: ReadonlyArray<SemanticPageInput>
): ReadonlyArray<SemanticSectionNode> => {
  const rootChildren: MutableSemanticSectionNode[] = []
  const stack: MutableSemanticSectionNode[] = []
  const emittedKeys = new Set<string>()
  let nextId = 1

  for (const page of pages) {
    const lines = page.text
      .split(/\r?\n/)
      .map(normalizeLine)
      .filter(Boolean)

    if (lines.length === 0) continue
    const contentsPage = isContentsHeading(lines[0] || "")

    for (const line of lines) {
      const heading = detectHeading(line)
      if (!heading || contentsPage) continue
      const emittedKey = `${heading.level}:${heading.title}`
      if (emittedKeys.has(emittedKey)) continue

      const node: MutableSemanticSectionNode = {
        id: `section-${nextId}`,
        type: "section",
        title: heading.title,
        level: heading.level,
        pageNumber: page.pageNumber,
        pageArtifactPath: page.artifactPath,
        excerpt: excerptFor(line),
        children: [],
      }
      nextId += 1
      emittedKeys.add(emittedKey)

      while (stack.length > 0 && (stack[stack.length - 1]?.level || 0) >= heading.level) {
        stack.pop()
      }

      const parent = stack[stack.length - 1]
      if (parent) {
        parent.children.push(node)
      } else {
        rootChildren.push(node)
      }
      stack.push(node)
    }
  }

  return rootChildren.map(toReadonlyTree)
}
