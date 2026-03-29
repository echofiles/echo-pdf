# Workspace Artifact Contract

This document defines the local workspace artifact contract for `echo-pdf`.

It is the contract downstream local apps and operators may rely on when they read `.echo-pdf-workspace/` directly.

## Scope

This contract covers:

- required directory layout for materialized artifacts
- required JSON artifact files and their purpose
- cache reuse and invalidation semantics
- detector / strategy metadata requirements
- traceability guarantees and downstream-safe assumptions

This contract does not add new extraction features or change downstream product behavior.

## Workspace Root

By default, `echo-pdf` writes artifacts to:

```text
.echo-pdf-workspace/
```

Callers may override the root with `workspaceDir` or `--workspace`.

## Directory Layout

```text
<workspace>/
  documents/
    <documentId>/
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
        ...
      ocr/
        0001.scale-2.provider-openai.model-gpt-4o.prompt-<hash>.json
        ...
```

Layout rules:

- `document.json`, `structure.json`, and `pages/*.json` are the required baseline artifacts after document indexing.
- `semantic-structure.json` is materialized only after semantic extraction runs.
- `renders/*` artifacts are materialized only after page rendering runs.
- `ocr/*` artifacts are materialized only after OCR runs.

## Document Identity

`documentId` is derived from the absolute source PDF path.

Implications:

- the same file path maps to the same `documentId` inside a workspace
- the same bytes at a different path produce a different `documentId`
- `documentId` is not a content hash and should not be treated as a portable global document identifier

Downstream systems may use `documentId` as a local workspace key, but should not use it as a cross-machine or cross-path identity.

## Required Artifact Files

### `document.json`

Authoritative metadata for the indexed source PDF.

Required fields:

- `documentId`
- `sourcePath`
- `filename`
- `sizeBytes`
- `mtimeMs`
- `pageCount`
- `indexedAt`
- `artifactPaths`

Downstream use:

- trace a workspace document directory back to the indexed local file
- compare source snapshot fields (`sizeBytes`, `mtimeMs`) with derived artifacts
- locate sibling artifacts through `artifactPaths`

### `structure.json`

Stable page index contract.

Required fields:

- `documentId`
- `generatedAt`
- `root`

`root` must remain:

- `type: "document"`
- `title: <source filename>`
- `children: pages[]`

Each page child must expose:

- `id`
- `type: "page"`
- `title`
- `pageNumber`
- `preview`
- `artifactPath`

Downstream use:

- page iteration
- page-level routing and lookup
- locating `pages/<page>.json`

### `pages/<page>.json`

Page content artifact.

Required fields:

- `documentId`
- `pageNumber`
- `title`
- `preview`
- `text`
- `chars`
- `artifactPath`

Downstream use:

- page text retrieval
- semantic extraction input
- direct page-level fallback when richer artifacts are unavailable

### `semantic-structure.json`

Optional semantic layer. It does not replace `structure.json`.

Required fields when present:

- `documentId`
- `generatedAt`
- `detector`
- `strategyKey`
- `sourceSizeBytes`
- `sourceMtimeMs`
- `pageIndexArtifactPath`
- `artifactPath`
- `root`

`root` must remain:

- `type: "document"`
- `title: <source filename>`
- `children: semantic sections[]`

Each semantic section may expose:

- `id`
- `type: "section"`
- `title`
- `level`
- `pageNumber`
- `pageArtifactPath`
- `excerpt`
- `children`

Detector requirements:

- `detector` must identify the semantic extraction path that produced the artifact
- current values are `agent-structured-v1` and `heading-heuristic-v1`
- downstream consumers may branch on detector identity, but should handle unknown future detectors conservatively

Strategy requirements:

- `strategyKey` must change when the semantic extraction strategy changes in a way that affects artifact validity
- for agent-based extraction, this includes provider/model and semantic extraction budget settings
- for heuristic extraction, this identifies the heuristic strategy version

### `renders/<page>.scale-<scale>.json` and `.png`

Optional page render artifacts.

Required JSON fields:

- `documentId`
- `pageNumber`
- `renderScale`
- `sourceSizeBytes`
- `sourceMtimeMs`
- `width`
- `height`
- `mimeType`
- `imagePath`
- `artifactPath`
- `generatedAt`

The sibling `.png` file is the actual rendered image addressed by `imagePath`.

Downstream use:

- visual page inspection
- OCR/image reuse without rerendering the same page

### `ocr/<page>...json`

Optional OCR artifact.

Required fields:

- `documentId`
- `pageNumber`
- `renderScale`
- `sourceSizeBytes`
- `sourceMtimeMs`
- `provider`
- `model`
- `prompt`
- `text`
- `chars`
- `imagePath`
- `renderArtifactPath`
- `artifactPath`
- `generatedAt`

The OCR filename must encode:

- page number
- render scale
- provider
- model
- prompt hash

The full prompt remains in the JSON artifact; downstream consumers should not reconstruct the prompt from the filename hash.

## Cache Semantics

### Baseline indexing reuse

`get_document()`, `get_document_structure()`, and `get_page_content()` may reuse prior indexing only when all of the following are true:

- `document.json` exists
- `structure.json` exists
- every `pages/<page>.json` for the indexed page count exists
- the indexed source snapshot still matches `sizeBytes` and `mtimeMs`

If any of those fail, the baseline document/page artifacts are rebuilt.

### Render / OCR / Semantic reuse

Render, OCR, and semantic artifacts are reusable only when their source snapshot matches the current `document.json` snapshot.

Implications:

- if the PDF at the same path changes, stale render/OCR/semantic artifacts must not be reused
- reusing the same path with different bytes keeps the same `documentId`, but artifacts are refreshed against the new source snapshot
- `forceRefresh` bypasses reuse and rewrites the addressed artifact

Additional reuse rules:

- render artifacts are keyed by page number and render scale
- OCR artifacts are keyed by page number, render scale, provider, model, and prompt hash
- semantic artifacts are keyed by source snapshot plus `strategyKey`

## Traceability Guarantees

Downstream consumers may rely on the following traceability chain:

- `document.json` identifies the indexed source file and artifact directory
- `structure.json.root.children[*].artifactPath` points to page JSON artifacts
- `semantic-structure.json.pageIndexArtifactPath` points back to `structure.json`
- semantic section nodes may point back to `pages/<page>.json` via `pageArtifactPath`
- OCR artifacts point back to their render metadata via `renderArtifactPath`
- render metadata points to the actual PNG via `imagePath`

## Downstream-Safe Assumptions

Downstream consumers may rely on:

- the workspace root containing `documents/<documentId>/...`
- the artifact filenames and directory classes documented above
- the required JSON fields listed in this document
- source snapshot matching via `sizeBytes` and `mtimeMs`
- `structure.json` remaining the stable page index contract
- `semantic-structure.json` remaining a separate semantic layer instead of mutating `pages[]`

Downstream consumers should not rely on:

- undocumented JSON fields
- `documentId` as a portable cross-machine identity
- the exact prompt-hash algorithm
- internal implementation modules or deep import paths
- every optional artifact existing before its corresponding primitive has been called

## Runtime Return Values vs Persisted Artifacts

Some local API return values include transient runtime fields such as `cacheStatus`.

Those fields are useful to callers, but they are not part of the persisted workspace JSON contract unless explicitly listed above.
