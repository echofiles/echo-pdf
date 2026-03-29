# Product Positioning

`echo-pdf` is a local-first, vision-language-first PDF context engine for AI agents.

## One-Sentence Definition

`echo-pdf` turns local PDFs into reusable CLI outputs, local library primitives, and inspectable workspace artifacts for page rendering, page understanding, semantic structure, and downstream local reuse.

## Primary Product Surfaces

- npm package: `@echofiles/echo-pdf`
- local CLI: `echo-pdf ...`
- local workspace artifacts: `.echo-pdf-workspace/...`
- documentation site: install and contract docs only

These are the product surfaces that define the current phase. They carry the primary product and semver expectations.

For the package-level contract, see [`docs/PACKAGING.md`](./PACKAGING.md).

## Target Users

- developers building local AI agents or IDE integrations that need PDF context
- downstream apps that need stable page-level document primitives and cached local artifacts
- consumers who want a clean package import plus a local CLI workflow, without depending on a hosted service

## Primary Use Cases

- index a local PDF into reusable page metadata and artifacts
- render pages into reusable visual artifacts for downstream VL workflows
- extract page-level text and semantic structure that downstream agents can navigate
- expose stable local document context primitives to a Node/Bun app
- let downstream local tools reuse the same workspace artifacts instead of reparsing the same file

## Current Architecture Direction

The mainline product path is:

- render
- page understanding
- semantic structure
- workspace artifacts

OCR may remain in the repo as a compatibility or fallback path, but it no longer defines the primary product direction or the main capability story.

## Non-Goals For This Phase

- hosted SaaS or multi-tenant platform work
- treating MCP as the primary product entrypoint
- turning the website into an online PDF processing service
- domain-specific extraction logic such as datasheet- or EDA-specific behavior
- broad tool-surface expansion beyond the core local primitives

## Product Boundary

`echo-pdf` is a general PDF component. It is not the place to encode downstream product policy or domain semantics.

The intended boundary is:

- `echo-pdf` produces general document/page artifacts and primitives
- downstream products consume those artifacts and add product-specific logic outside this repo

## Secondary / Compatibility Surfaces

Worker and MCP surfaces may remain in the repo for compatibility, but they are not the primary shape of the product in the current phase.

When the docs mention service or Worker endpoints, read them as compatibility surfaces rather than the main adoption path.

For the artifact-level contract that downstream local products may depend on, see [`docs/WORKSPACE_CONTRACT.md`](./WORKSPACE_CONTRACT.md).
