# Sample Organization Rules

`echo-pdf` keeps test/eval purpose and sample ownership separate:

- `tests/` owns release-gating verification
- `eval/` owns non-gating measurement
- `samples/` owns shared PDF assets for both layers

## Shared Sample Layer

- `samples/repo-owned/`
  - checked-in canonical PDFs versioned with the repo
  - used where release-gating paths need stable local inputs
- `samples/public-cache/`
  - fetched local cache of official/public PDFs
  - hydrated with `bun run eval:fetch-public-samples`
  - shared by acceptance tests and eval suites
- `samples/public-sources.json`
  - registry of public documents and stable local filenames

## Rules

1. Prefer public, officially hosted knowledge and guidance PDFs when a behavior can be represented by a stable public source.
2. Fetch shared public PDFs into `samples/public-cache/`; do not make product runtime depend on fetching them.
3. Keep deterministic repo-owned PDFs in `samples/repo-owned/` when gating tests need checked-in canonical inputs.
4. Keep deterministic synthetic cases only for gaps that cannot be represented by repo-owned or public documents.
5. One `caseId` per behavior under test.
6. Put expectations in manifests, not in free-form notes.
7. Split suites by operational purpose, not by author preference.

## Verification Fit

- `tests/unit/`
  - fast logic checks only
- `tests/integration/`
  - packaging / runtime / CLI / built-path gating
- `tests/acceptance/`
  - a small number of high-value product gates on canonical real PDFs
- `eval/`
  - suite-based non-gating measurement (`smoke`, `core`, `stress`, `known-bad`)

## Eval Suite Fit

- `smoke`
  - minimal deterministic cases, no provider dependency
- `core`
  - representative knowledge/guidance documents with stable expectations
- `stress`
  - long-context, high-density, or budget-sensitive guidance documents
- `known-bad`
  - tracked unsupported layouts or behaviors

## Naming

- manifest file: `<suite>.json`
- case id: `<modality>-<behavior>-<shape>`
- config id: `<modality>-<mode>-<budget-or-prompt>`

## Evidence

Every run should leave:

- manifest path
- source or generated PDF path
- output workspace path
- summary JSON path
- artifact paths for semantic outputs
