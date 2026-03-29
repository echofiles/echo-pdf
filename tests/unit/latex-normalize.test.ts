import { describe, expect, it } from "vitest"
import { normalizeTableItems, normalizeFormulaItems } from "../../src/local/shared"

describe("normalizeTableItems", () => {
  it("keeps valid tabular environments and drops invalid ones", () => {
    const items = normalizeTableItems([
      { latexTabular: "\\begin{tabular}{cc}\na & b\\\\\n\\end{tabular}", caption: "Table 1" },
      { latexTabular: "not a table" },
      { latexTabular: "```latex\n\\begin{tabular}{c}\nvalue\\\\\n\\end{tabular}\n```" },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]?.id).toBe("table-1")
    expect(items[0]?.latexTabular).toContain("\\begin{tabular}")
    expect(items[0]?.caption).toBe("Table 1")
    expect(items[1]?.id).toBe("table-3")
  })

  it("returns empty array for non-array input", () => {
    expect(normalizeTableItems(null)).toEqual([])
    expect(normalizeTableItems("bad")).toEqual([])
  })
})

describe("normalizeFormulaItems", () => {
  it("keeps non-empty latex math and drops empty ones", () => {
    const items = normalizeFormulaItems([
      { latexMath: "E = mc^2", label: "eq:1" },
      { latexMath: "" },
      { latexMath: "```latex\n\\frac{a}{b}\n```" },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]?.id).toBe("formula-1")
    expect(items[0]?.latexMath).toBe("E = mc^2")
    expect(items[0]?.label).toBe("eq:1")
    expect(items[1]?.latexMath).toBe("\\frac{a}{b}")
  })

  it("returns empty array for non-array input", () => {
    expect(normalizeFormulaItems(undefined)).toEqual([])
  })
})
