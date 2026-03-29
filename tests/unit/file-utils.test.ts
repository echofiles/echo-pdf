import { describe, expect, it } from "vitest"
import { fromBase64, toBase64, toDataUrl } from "../../src/file-utils"

describe("file-utils", () => {
  it("encodes and decodes base64", () => {
    const bytes = new TextEncoder().encode("echo-pdf")
    const encoded = toBase64(bytes)
    const decoded = fromBase64(encoded)
    expect(new TextDecoder().decode(decoded)).toBe("echo-pdf")
  })

  it("converts bytes to data url", () => {
    const dataUrl = toDataUrl(new Uint8Array([1, 2, 3]), "application/octet-stream")
    expect(dataUrl).toMatch(/^data:application\/octet-stream;base64,/)
  })
})
