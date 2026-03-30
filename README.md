# echo-pdf

`echo-pdf` is a local-first, vision-language-first PDF context engine for AI agents.

It turns a local PDF into reusable CLI outputs, Node/Bun library primitives, and inspectable workspace artifacts for page rendering, page understanding, semantic structure, and downstream local reuse.

## What It Is

Primary product surfaces:

- npm package: `@echofiles/echo-pdf`
- local CLI: `echo-pdf ...`
- local workspace artifacts: `.echo-pdf-workspace/...`
- docs site: [pdf.echofile.ai](https://pdf.echofile.ai/)

Current focus:

- local-first workflows
- VL-first page understanding
- stable page-level document primitives
- reusable workspace artifacts
- clean package entrypoints for downstream consumers

Non-goals for this phase:

- hosted SaaS
- treating MCP as the primary product entrypoint
- turning the docs site into an online PDF processing service
- domain-specific logic such as datasheet- or EDA-specific extraction behavior

## Install

Requirements:

- Node.js `>=20`
- ESM-capable runtime

Install globally for CLI use:

```bash
npm i -g @echofiles/echo-pdf
```

Or install as a dependency:

```bash
npm i @echofiles/echo-pdf
```

## Quick Start

Index a local PDF and inspect its page-level context:

```bash
echo-pdf document ./sample.pdf
echo-pdf structure ./sample.pdf
echo-pdf page ./sample.pdf --page 1
echo-pdf render ./sample.pdf --page 1 --scale 2
```

To run provider-required primitives, configure a provider key and model once:

```bash
echo-pdf provider set --provider openai --api-key "$OPENAI_API_KEY"
echo-pdf model set --provider openai --model gpt-4.1-mini

echo-pdf semantic ./sample.pdf
echo-pdf tables ./sample.pdf --page 1
echo-pdf formulas ./sample.pdf --page 1
echo-pdf understanding ./sample.pdf --page 1
```

Provider-required primitives (`semantic`, `tables`, `formulas`, `understanding`) use the CLI profile's provider/model/api-key settings. If the selected provider or model is missing, they fail early with a clear setup error.

The CLI ships with a built-in `ollama` provider alias pointing at `http://127.0.0.1:11434/v1`. To use a local Ollama server:

```bash
echo-pdf provider set --provider ollama --api-key ""
echo-pdf model set --provider ollama --model llava:13b
echo-pdf semantic ./sample.pdf --provider ollama
```

The built-in provider aliases are `openai`, `vercel_gateway`, `openrouter`, and `ollama`. Other local OpenAI-compatible servers (llama.cpp, vLLM, LM Studio, LocalAI) can be configured by overriding the config via the `ECHO_PDF_CONFIG_JSON` environment variable or by editing the bundled `echo-pdf.config.json` in a source checkout. The selected model must support vision input.

What these commands map to:

- `document` -> `get_document`
- `structure` -> `get_document_structure`
- `semantic` -> `get_semantic_document_structure`
- `page` -> `get_page_content`
- `render` -> `get_page_render`
- `tables` -> `get_page_tables_latex`
- `formulas` -> `get_page_formulas_latex`
- `understanding` -> `get_page_understanding`

By default, `echo-pdf` writes reusable artifacts into a local workspace:

```text
.echo-pdf-workspace/
  documents/<documentId>/
    document.json
    structure.json
    semantic-structure.json
    pages/
      0001.json
      0002.json
      ...
    renders/
      0001.scale-2.json
      0001.scale-2.png
    tables/
      0001.scale-2.provider-openai.model-gpt-4.1-mini.prompt-<hash>.json
    formulas/
      0001.scale-2.provider-openai.model-gpt-4.1-mini.prompt-<hash>.json
    understanding/
      0001.scale-2.provider-openai.model-gpt-4.1-mini.prompt-<hash>.json
```

These artifacts are meant to be inspected, cached, and reused by downstream local tools.
## Library Usage

Use the local document primitives directly from Node/Bun:

```ts
import {
  get_document,
  get_document_structure,
  get_semantic_document_structure,
  get_page_content,
  get_page_render,
  get_page_tables_latex,
  get_page_formulas_latex,
  get_page_understanding,
} from "@echofiles/echo-pdf/local"

const document = await get_document({ pdfPath: "./sample.pdf" })
const structure = await get_document_structure({ pdfPath: "./sample.pdf" })
const semantic = await get_semantic_document_structure({
  pdfPath: "./sample.pdf",
  provider: "openai",
  model: "gpt-4.1-mini",
})
const page1 = await get_page_content({ pdfPath: "./sample.pdf", pageNumber: 1 })
const render1 = await get_page_render({ pdfPath: "./sample.pdf", pageNumber: 1, scale: 2 })
const tables = await get_page_tables_latex({ pdfPath: "./sample.pdf", pageNumber: 1, provider: "openai", model: "gpt-4.1-mini" })
const formulas = await get_page_formulas_latex({ pdfPath: "./sample.pdf", pageNumber: 1, provider: "openai", model: "gpt-4.1-mini" })
const understanding = await get_page_understanding({ pdfPath: "./sample.pdf", pageNumber: 1, provider: "openai", model: "gpt-4.1-mini" })
```

Notes:

- `get_document_structure()` returns the stable page index: `document -> pages[]`
- `get_semantic_document_structure()` returns a heading/section tree plus optional cross-page merged `tables[]`, `formulas[]`, and `figures[]`; it does not replace `pages[]`
- `get_page_render()` materializes a reusable PNG plus render metadata and is the mainline visual input path
- `get_page_understanding()` extracts tables, formulas, and figures from a single page in one LLM call

Migration note:

- older workspaces may still contain `ocr/*` artifacts from pre-VL-first builds, but they are no longer part of the supported first-class contract

## Public Package Entrypoints

The semver-stable public entrypoints are:

- `@echofiles/echo-pdf`
- `@echofiles/echo-pdf/local`

`@echofiles/echo-pdf` and `@echofiles/echo-pdf/local` expose the same supported local-first library surface.

Everything else, including deep imports such as `src/*` or `dist/*`, is private implementation detail.

## Docs

Contract and product docs:

- [Product positioning](./docs/PRODUCT.md)
- [Package entrypoints and integration guarantees](./docs/PACKAGING.md)
- [Workspace artifact contract](./docs/WORKSPACE_CONTRACT.md)
- [Development guide](./docs/DEVELOPMENT.md)
- [Shared sample assets](./samples/README.md)
- [Eval harness](./eval/README.md)

Published docs site:

- [pdf.echofile.ai](https://pdf.echofile.ai/)

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run test:unit
npm run test:acceptance
npm run test:integration
```

For source-checkout CLI development and repo-local workflows, see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## License

Apache-2.0
