import { describe, expect, it } from "vitest"
import { parseJsonObjectWithRepair } from "../../src/local/shared.js"

describe("parseJsonObjectWithRepair", () => {
  it("repairs invalid backslash escapes inside JSON strings", () => {
    const result = parseJsonObjectWithRepair(String.raw`{"sections":[{"title":"1 Introduction","excerpt":"See Equation \(1\) and value \_x"}]}`)

    expect(result.repaired).toBe(true)
    expect(result.parsed).toEqual({
      sections: [
        {
          title: "1 Introduction",
          excerpt: String.raw`See Equation \(1\) and value \_x`,
        },
      ],
    })
  })

  it("still rejects unrecoverable malformed JSON", () => {
    expect(() => parseJsonObjectWithRepair('{"sections": [')).toThrow()
  })
})
