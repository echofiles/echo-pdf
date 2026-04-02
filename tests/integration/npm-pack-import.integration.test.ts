import { describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { repoOwnedSamplePaths } from "../../samples/index.js"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = repoOwnedSamplePaths.smokePdf

const run = async (cmd: string, args: string[], cwd: string): Promise<string> => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, env: process.env })
  void stderr
  return stdout
}

describe("package pack import smoke", () => {
  it("imports package root/local and executes the packaged local runtime", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-pack-"))
    const packDir = path.join(tempDir, "pack")
    await run("mkdir", ["-p", packDir], rootDir)
    const packedFilename = (await run("bun", ["pm", "pack", "--quiet", "--destination", packDir], rootDir)).trim()
    expect(packedFilename.endsWith(".tgz")).toBe(true)
    const tgzPath = path.isAbsolute(packedFilename) ? packedFilename : path.join(packDir, packedFilename)

    try {
      await writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "echo-pdf-pack-smoke", private: true }, null, 2))
      await run("bun", ["add", tgzPath], tempDir)
      const code = [
        "const root = await import('@echofiles/echo-pdf')",
        "const local = await import('@echofiles/echo-pdf/local')",
        "if (typeof root.get_document !== 'function') throw new Error('root.get_document missing')",
        "if (typeof local.get_document !== 'function') throw new Error('local.get_document missing')",
        "if (typeof local.get_semantic_document_structure !== 'function') throw new Error('local.get_semantic_document_structure missing')",
        "if (typeof local.get_page_render !== 'function') throw new Error('local.get_page_render missing')",
        "if (typeof root.get_page_render !== 'function') throw new Error('root.get_page_render missing')",
        "if (typeof local.get_page_tables_latex !== 'function') throw new Error('local.get_page_tables_latex missing')",
        "if (typeof local.get_page_formulas_latex !== 'function') throw new Error('local.get_page_formulas_latex missing')",
        "if (typeof local.get_page_understanding !== 'function') throw new Error('local.get_page_understanding missing')",
        "const pdfPath = process.argv[1]",
        "const workspaceDir = process.argv[2]",
        "const doc = await local.get_document({ pdfPath, workspaceDir })",
        "const render = await local.get_page_render({ pdfPath, workspaceDir, pageNumber: 1 })",
        "if (!doc.pageCount) throw new Error('pageCount missing')",
        "if (render.mimeType !== 'image/png') throw new Error('render mimeType mismatch')",
        "console.log('ok')",
      ].join(";")
      const output = await run("node", ["--input-type=module", "-e", code, fixturePdf, path.join(tempDir, "workspace")], tempDir)
      expect(output.trim()).toContain("ok")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
