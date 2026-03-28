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

const isContentsHeading = (value: string): boolean => {
  const normalized = normalizeLine(value).toLowerCase()
  return normalized === "contents" || normalized === "table of contents" || normalized === "目录"
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
    if (/[。；;：:]$/.test(title)) return null
    if (Number.isFinite(topLevelNumber) && topLevelNumber > 20) return null
    if (/^[A-Z]+\d+$/.test(title)) return null
    if (level === 1 && title.length > 40) return null
    if (level === 1 && /[，,×—]/.test(title)) return null
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
