import { describe, expect, it } from "vitest"
import { buildSemanticSectionTree } from "../../src/node/semantic-local.js"

describe("semantic heuristic fallback", () => {
  it("builds a nested section tree from numbered headings", () => {
    const sections = buildSemanticSectionTree([
      {
        pageNumber: 1,
        artifactPath: "/tmp/page-1.json",
        text: [
          "Document Guide",
          "",
          "1 Overview",
          "Overview body",
          "1.1 Goals",
          "Goals body",
        ].join("\n"),
      },
      {
        pageNumber: 2,
        artifactPath: "/tmp/page-2.json",
        text: [
          "2 Usage",
          "Usage body",
          "2.1 Commands",
        ].join("\n"),
      },
    ])

    expect(sections).toHaveLength(2)
    expect(sections[0]).toMatchObject({
      title: "1 Overview",
      level: 1,
      pageNumber: 1,
    })
    expect(sections[0]?.children?.[0]).toMatchObject({
      title: "1.1 Goals",
      level: 2,
      pageNumber: 1,
    })
    expect(sections[1]).toMatchObject({
      title: "2 Usage",
      level: 1,
      pageNumber: 2,
    })
    expect(sections[1]?.children?.[0]).toMatchObject({
      title: "2.1 Commands",
      level: 2,
      pageNumber: 2,
    })
  })

  it("skips table-of-contents style entries", () => {
    const sections = buildSemanticSectionTree([
      {
        pageNumber: 1,
        artifactPath: "/tmp/page-1.json",
        text: [
          "目录",
          "1 Overview 1",
          "1.1 Goals 1",
          "2 Usage 2",
        ].join("\n"),
      },
      {
        pageNumber: 2,
        artifactPath: "/tmp/page-2.json",
        text: [
          "1 Overview",
          "Real content",
        ].join("\n"),
      },
    ])

    expect(sections).toHaveLength(1)
    expect(sections[0]?.title).toBe("1 Overview")
    expect(sections[0]?.pageNumber).toBe(2)
  })

  it("suppresses common datasheet/form noise in the fallback detector while keeping real headings", () => {
    const sections = buildSemanticSectionTree([
      {
        pageNumber: 1,
        artifactPath: "/tmp/page-1.json",
        text: [
          "1 Features",
          "PART NUMBER CHANNEL COUNT PACKAGE(2) PACKAGE SIZE(3)",
          "5 PINS 5 PINS",
          "20 pF",
          "Section references are to the Internal Revenue Code unless",
          "2 Applications",
          "3 Description",
          "8 Limitation on itemized deductions.",
        ].join("\n"),
      },
    ])

    expect(sections.map((section) => section.title)).toEqual([
      "1 Features",
      "2 Applications",
      "3 Description",
    ])
  })

  it("suppresses low-evidence zero-prefixed labels in the fallback detector", () => {
    const sections = buildSemanticSectionTree([
      {
        pageNumber: 1,
        artifactPath: "/tmp/page-1.json",
        text: [
          "0 TYP",
          "1 Overview",
          "2 FAQ",
          "3 API Surface",
        ].join("\n"),
      },
    ])

    expect(sections.map((section) => section.title)).toEqual([
      "1 Overview",
      "2 FAQ",
      "3 API Surface",
    ])
  })
})
