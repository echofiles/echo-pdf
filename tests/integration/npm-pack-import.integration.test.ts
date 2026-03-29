import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")

const run = async (cmd: string, args: string[], cwd: string): Promise<string> => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, env: process.env })
  if (stderr?.trim()) {
    // npm writes notices to stderr even on success; keep stdout authoritative.
  }
  return stdout
}

describe("npm pack import smoke", () => {
  it("imports package root/local from packed artifact", async () => {
    const packJson = await run("npm", ["pack", "--json"], rootDir)
    const parsed = JSON.parse(packJson) as Array<{ filename?: string }>
    const filename = parsed[0]?.filename
    expect(typeof filename).toBe("string")
    const tgzPath = path.join(rootDir, String(filename))

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-pack-"))
    try {
      await run("npm", ["init", "-y"], tempDir)
      await run("npm", ["i", tgzPath], tempDir)
      const code = [
        "const root = await import('@echofiles/echo-pdf')",
        "const local = await import('@echofiles/echo-pdf/local')",
        "if (typeof root.get_document !== 'function') throw new Error('root.get_document missing')",
        "if (typeof local.get_document !== 'function') throw new Error('local.get_document missing')",
        "if (typeof local.get_semantic_document_structure !== 'function') throw new Error('local.get_semantic_document_structure missing')",
        "if (typeof local.get_page_render !== 'function') throw new Error('local.get_page_render missing')",
        "if (typeof root.get_page_render !== 'function') throw new Error('root.get_page_render missing')",
        "console.log('ok')",
      ].join(";")
      const output = await run("node", ["--input-type=module", "-e", code], tempDir)
      expect(output.trim()).toContain("ok")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
