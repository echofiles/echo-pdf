import { describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")

const run = async (cmd: string, args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync(cmd, args, { cwd, env: process.env })
  return stdout
}

describe("ts nodenext consumer smoke", () => {
  it("typechecks package root/local imports in a fresh consumer", async () => {
    const packJson = await run("npm", ["pack", "--json"], rootDir)
    const parsed = JSON.parse(packJson) as Array<{ filename?: string }>
    const filename = parsed[0]?.filename
    expect(typeof filename).toBe("string")
    const tgzPath = path.join(rootDir, String(filename))

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-ts-"))
    try {
      await run("npm", ["init", "-y"], tempDir)
      await run("npm", ["i", tgzPath], tempDir)
      await run("npm", ["i", "-D", "typescript@5"], tempDir)

      await writeFile(path.join(tempDir, "index.ts"), [
        "import * as pkg from '@echofiles/echo-pdf'",
        "import * as local from '@echofiles/echo-pdf/local'",
        "pkg.get_document",
        "pkg.get_page_render",
        "local.get_document",
        "local.get_semantic_document_structure",
        "local.get_page_render",
        "local.get_page_tables_latex",
        "local.get_page_formulas_latex",
        "local.get_page_understanding",
        "",
      ].join("\n"))
      await writeFile(path.join(tempDir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        include: ["index.ts"],
      }, null, 2))

      await run("npx", ["tsc", "--noEmit"], tempDir)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
