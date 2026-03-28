import { writeFile } from "node:fs/promises"

const escapePdfText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")

const makeContentStream = (lines: readonly string[]): string => {
  const sanitized = lines.map((line) => escapePdfText(line))
  const body: string[] = [
    "BT",
    "/F1 18 Tf",
    "72 760 Td",
  ]
  sanitized.forEach((line, index) => {
    if (index > 0) body.push("0 -24 Td")
    body.push(`(${line}) Tj`)
  })
  body.push("ET")
  return `${body.join("\n")}\n`
}

export const writeSimplePdf = async (
  targetPath: string,
  pages: ReadonlyArray<ReadonlyArray<string>>
): Promise<void> => {
  const objects: string[] = []
  objects.push("<< /Type /Catalog /Pages 2 0 R >>")

  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2)
  const contentObjectNumbers = pages.map((_, index) => 5 + index * 2)
  objects.push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectNumbers.map((id) => `${id} 0 R`).join(" ")}] >>`)
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

  pages.forEach((lines, index) => {
    const pageObjectNumber = pageObjectNumbers[index]
    const contentObjectNumber = contentObjectNumbers[index]
    objects[pageObjectNumber - 1] = [
      "<< /Type /Page",
      "/Parent 2 0 R",
      "/MediaBox [0 0 612 792]",
      "/Resources << /Font << /F1 3 0 R >> >>",
      `/Contents ${contentObjectNumber} 0 R`,
      ">>",
    ].join(" ")

    const stream = makeContentStream(lines)
    objects[contentObjectNumber - 1] = [
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>`,
      "stream",
      stream.trimEnd(),
      "endstream",
    ].join("\n")
  })

  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((objectBody, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "utf8")
    pdf += `${index + 1} 0 obj\n${objectBody}\nendobj\n`
  })

  const xrefOffset = Buffer.byteLength(pdf, "utf8")
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += "0000000000 65535 f \n"
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index] || 0).padStart(10, "0")} 00000 n \n`
  }
  pdf += [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n")

  await writeFile(targetPath, pdf, "utf8")
}
