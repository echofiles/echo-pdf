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

To run the VL-first semantic path locally, configure a provider key and model once, then run `semantic`:

```bash
echo-pdf provider set --provider openai --api-key "$OPENAI_API_KEY"
echo-pdf model set --provider openai --model gpt-4.1-mini
echo-pdf semantic ./sample.pdf
```

`echo-pdf semantic` now uses the CLI profile's provider/model/api-key settings. If the selected provider or model is missing, it fails early with a clear setup error instead of quietly dropping back to a weaker path.

What these commands map to:

- `document` -> `get_document`
- `structure` -> `get_document_structure`
- `semantic` -> `get_semantic_document_structure`
- `page` -> `get_page_content`
- `render` -> `get_page_render`

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
} from "@echofiles/echo-pdf/local"

const document = await get_document({ pdfPath: "./sample.pdf" })
const structure = await get_document_structure({ pdfPath: "./sample.pdf" })
const semantic = await get_semantic_document_structure({ pdfPath: "./sample.pdf" })
const page1 = await get_page_content({ pdfPath: "./sample.pdf", pageNumber: 1 })
const render1 = await get_page_render({ pdfPath: "./sample.pdf", pageNumber: 1, scale: 2 })
```

Notes:

- `get_document_structure()` returns the stable page index: `document -> pages[]`
- `get_semantic_document_structure()` returns a separate semantic structure layer; it does not replace `pages[]`
- `get_page_render()` materializes a reusable PNG plus render metadata and is the mainline visual input path

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
- [Eval harness](./eval/README.md)

Published docs site:

- [pdf.echofile.ai](https://pdf.echofile.ai/)

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run test:unit
npm run test:integration
```

For source-checkout CLI development and repo-local workflows, see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## License

Apache-2.0
