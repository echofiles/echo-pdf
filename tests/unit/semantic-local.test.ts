import { describe, expect, it } from "vitest"
import { buildSemanticSectionTree } from "../../src/node/semantic-local.js"

describe("semantic section tree", () => {
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
})
