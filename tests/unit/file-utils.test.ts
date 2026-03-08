import { describe, expect, it } from "vitest"
import { fromBase64, normalizeReturnMode, toBase64, toDataUrl, toInlineFilePayload } from "../../src/file-utils"

describe("file-utils", () => {
  it("encodes and decodes base64", () => {
    const bytes = new TextEncoder().encode("echo-pdf")
    const encoded = toBase64(bytes)
    const decoded = fromBase64(encoded)
    expect(new TextDecoder().decode(decoded)).toBe("echo-pdf")
  })

  it("normalizes return mode", () => {
    expect(normalizeReturnMode("inline")).toBe("inline")
    expect(normalizeReturnMode("file_id")).toBe("file_id")
    expect(normalizeReturnMode("url")).toBe("url")
    expect(normalizeReturnMode("invalid")).toBe("inline")
  })

  it("builds inline payload for text and image files", () => {
    const textPayload = toInlineFilePayload(
      {
        id: "f1",
        filename: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        createdAt: new Date().toISOString(),
        bytes: new TextEncoder().encode("abc"),
      },
      true
    )
    expect(textPayload.text).toBe("abc")
    expect(typeof textPayload.base64).toBe("string")

    const imagePayload = toInlineFilePayload(
      {
        id: "f2",
        filename: "a.png",
        mimeType: "image/png",
        sizeBytes: 3,
        createdAt: new Date().toISOString(),
        bytes: new Uint8Array([137, 80, 78]),
      },
      false
    )
    expect(typeof imagePayload.dataUrl).toBe("string")
    expect(String(imagePayload.dataUrl)).toMatch(/^data:image\/png;base64,/)
  })

  it("converts bytes to data url", () => {
    const dataUrl = toDataUrl(new Uint8Array([1, 2, 3]), "application/octet-stream")
    expect(dataUrl).toMatch(/^data:application\/octet-stream;base64,/)
  })
})
