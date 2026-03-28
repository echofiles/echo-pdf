import { describe, expect, it } from "vitest"
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")
const fixturePdf = path.join(rootDir, "fixtures", "smoke.pdf")
const systemNodeMajor = Number(
  execFileSync("node", ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf-8" }).trim()
)
const itWithNode20 = systemNodeMajor >= 20 ? it : it.skip

const runCli = async (repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync("node", [path.join(repoDir, "bin", "echo-pdf.js"), ...args], {
    cwd: repoDir,
    env: process.env,
  })
  return { stdout, stderr }
}

describe("local document CLI", () => {
  itWithNode20("indexes and reads a PDF through document commands", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-cli-"))

    const { stdout: docRaw } = await runCli(rootDir, ["document", "get", fixturePdf, "--workspace", workspaceDir])
    const doc = JSON.parse(docRaw) as {
      documentId: string
      pageCount: number
      cacheStatus: "fresh" | "reused"
      artifactPaths: {
        documentJsonPath: string
      }
    }
    expect(doc.pageCount).toBeGreaterThan(0)
    expect(doc.cacheStatus).toBe("fresh")

    const { stdout: structureRaw } = await runCli(rootDir, ["document", "structure", fixturePdf, "--workspace", workspaceDir])
    const structure = JSON.parse(structureRaw) as {
      documentId: string
      root: {
        children?: Array<{ pageNumber?: number }>
      }
    }
    expect(structure.documentId).toBe(doc.documentId)
    expect(structure.root.children?.[0]?.pageNumber).toBe(1)

    const { stdout: pageRaw } = await runCli(rootDir, ["document", "page", fixturePdf, "--page", "1", "--workspace", workspaceDir])
    const page = JSON.parse(pageRaw) as {
      documentId: string
      pageNumber: number
      text: string
    }
    expect(page.documentId).toBe(doc.documentId)
    expect(page.pageNumber).toBe(1)
    expect(typeof page.text).toBe("string")

    const { stdout: docSecondRaw } = await runCli(rootDir, ["document", "get", fixturePdf, "--workspace", workspaceDir])
    const docSecond = JSON.parse(docSecondRaw) as {
      cacheStatus: "fresh" | "reused"
    }
    expect(docSecond.cacheStatus).toBe("reused")

    const stored = JSON.parse(await readFile(doc.artifactPaths.documentJsonPath, "utf-8")) as {
      documentId?: string
    }
    expect(stored.documentId).toBe(doc.documentId)
  })

  itWithNode20("fails fast with a build hint when dist artifacts are missing in a source checkout", async () => {
    const checkoutDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-source-"))
    await cp(path.join(rootDir, "bin"), path.join(checkoutDir, "bin"), { recursive: true })
    await cp(path.join(rootDir, "echo-pdf.config.json"), path.join(checkoutDir, "echo-pdf.config.json"))
    await writeFile(path.join(checkoutDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf-8")

    let failureMessage = ""
    try {
      await runCli(checkoutDir, ["document", "get", fixturePdf])
    } catch (error) {
      failureMessage = String(error instanceof Error ? error.message : error)
    }

    expect(failureMessage).toContain("npm run build")
    expect(failureMessage).toContain("Local document commands require built artifacts")
  })
})
