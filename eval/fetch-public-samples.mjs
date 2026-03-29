#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const registryPath = path.join(__dirname, "public-sources.json")
const targetDir = path.join(__dirname, "public-samples")

const parseFlags = (argv) => {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}

const readJson = async (targetPath) => JSON.parse(await fs.readFile(targetPath, "utf-8"))

const writeJson = async (targetPath, value) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

const downloadSample = async (sample, refresh) => {
  const targetPath = path.join(targetDir, sample.localFilename)
  if (!refresh) {
    try {
      await fs.stat(targetPath)
      return {
        id: sample.id,
        status: "reused",
        path: targetPath,
      }
    } catch {
      // fetch below
    }
  }

  const response = await fetch(sample.url)
  if (!response.ok) {
    throw new Error(`Download failed for ${sample.id}: HTTP ${response.status} ${sample.url}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer))
  return {
    id: sample.id,
    status: "fresh",
    path: targetPath,
    sizeBytes: arrayBuffer.byteLength,
  }
}

const run = async () => {
  const flags = parseFlags(process.argv.slice(2))
  const registry = await readJson(registryPath)
  const allSamples = Array.isArray(registry.samples) ? registry.samples : []
  const sampleIds = typeof flags.sample === "string"
    ? flags.sample.split(",").map((value) => value.trim()).filter(Boolean)
    : []
  const refresh = flags.refresh === true

  const samples = sampleIds.length > 0
    ? allSamples.filter((sample) => sampleIds.includes(sample.id))
    : allSamples

  if (samples.length === 0) {
    throw new Error("No public samples matched the requested ids.")
  }

  const results = []
  for (const sample of samples) {
    results.push(await downloadSample(sample, refresh))
  }

  const lockPath = path.join(targetDir, "sources.lock.json")
  await writeJson(lockPath, {
    fetchedAt: new Date().toISOString(),
    samples: allSamples.map((sample) => ({
      id: sample.id,
      localFilename: sample.localFilename,
      url: sample.url,
    })),
  })

  process.stdout.write(`${JSON.stringify({ ok: true, results, lockPath }, null, 2)}\n`)
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  process.exitCode = 1
})
