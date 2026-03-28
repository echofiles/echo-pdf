import { describe, expect, it } from "vitest"
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
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
const hasBun = (() => {
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf-8" }).trim().length > 0
  } catch {
    return false
  }
})()
const itWithNode20 = systemNodeMajor >= 20 ? it : it.skip
const itWithNode20AndBun = systemNodeMajor >= 20 && hasBun ? it : it.skip

const runCli = async (repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync("node", [path.join(repoDir, "bin", "echo-pdf.js"), ...args], {
    cwd: repoDir,
    env: process.env,
  })
  return { stdout, stderr }
}

const runSourceCheckoutDocumentDev = async (repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync("npm", ["run", "document:dev", "--", ...args], {
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

    const { stdout: renderRaw } = await runCli(rootDir, ["document", "render", fixturePdf, "--page", "1", "--workspace", workspaceDir])
    const render = JSON.parse(renderRaw) as {
      pageNumber: number
      mimeType: string
      imagePath: string
      cacheStatus: "fresh" | "reused"
    }
    expect(render.pageNumber).toBe(1)
    expect(render.mimeType).toBe("image/png")
    expect(render.cacheStatus).toBe("fresh")

    const { stdout: docSecondRaw } = await runCli(rootDir, ["document", "get", fixturePdf, "--workspace", workspaceDir])
    const docSecond = JSON.parse(docSecondRaw) as {
      cacheStatus: "fresh" | "reused"
    }
    expect(docSecond.cacheStatus).toBe("reused")

    const { stdout: renderSecondRaw } = await runCli(rootDir, ["document", "render", fixturePdf, "--page", "1", "--workspace", workspaceDir])
    const renderSecond = JSON.parse(renderSecondRaw) as {
      cacheStatus: "fresh" | "reused"
      imagePath: string
    }
    expect(renderSecond.cacheStatus).toBe("reused")
    expect(renderSecond.imagePath).toBe(render.imagePath)

    const stored = JSON.parse(await readFile(doc.artifactPaths.documentJsonPath, "utf-8")) as {
      documentId?: string
    }
    expect(stored.documentId).toBe(doc.documentId)
  })

  itWithNode20AndBun("supports a source-checkout document workflow even when dist artifacts exist", async () => {
    const checkoutDir = await mkdtemp(path.join(os.tmpdir(), "echo-pdf-source-"))
    await cp(path.join(rootDir, "bin"), path.join(checkoutDir, "bin"), { recursive: true })
    await cp(path.join(rootDir, "dist"), path.join(checkoutDir, "dist"), { recursive: true })
    await cp(path.join(rootDir, "src"), path.join(checkoutDir, "src"), { recursive: true })
    await cp(path.join(rootDir, "echo-pdf.config.json"), path.join(checkoutDir, "echo-pdf.config.json"))
    await cp(path.join(rootDir, "package.json"), path.join(checkoutDir, "package.json"))
    await symlink(path.join(rootDir, "node_modules"), path.join(checkoutDir, "node_modules"), "dir")
    await writeFile(
      path.join(checkoutDir, "dist", "local", "index.js"),
      'throw new Error("dist local entry should not load in document:dev");\n',
      "utf-8"
    )

    const { stdout } = await runSourceCheckoutDocumentDev(checkoutDir, ["get", fixturePdf, "--workspace", checkoutDir])
    const doc = JSON.parse(stdout.replace(/^>.*\n/gm, "").trim()) as {
      pageCount: number
      cacheStatus: "fresh" | "reused"
    }

    expect(doc.pageCount).toBeGreaterThan(0)
    expect(doc.cacheStatus).toBe("fresh")
  })
})
