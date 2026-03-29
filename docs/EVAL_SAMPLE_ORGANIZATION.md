# Sample Organization Rules

## Goals

Samples must be:

- local-first
- reproducible
- auditable
- comparable across model / prompt / budget profiles

## Rules

1. Prefer public, officially hosted knowledge and guidance PDFs.
2. Cache those PDFs locally with `eval/fetch-public-samples.mjs`.
3. Keep deterministic synthetic cases only for gaps that cannot be represented by public documents.
4. One `caseId` per behavior under test.
5. Put expectations in manifests, not in free-form notes.
6. Split suites by operational purpose, not by author preference.

## Suite Fit

- `smoke`
  Minimal deterministic cases. No provider dependency. Prefer real public dense docs.
- `core`
  Representative knowledge/guidance documents with stable expectations.
- `stress`
  Long-context, high-density, or budget-sensitive guidance documents.
- `known-bad`
  Tracked unsupported layouts or behaviors.

## Naming

- manifest file: `<suite>.json`
- case id: `<modality>-<behavior>-<shape>`
- config id: `<modality>-<mode>-<budget-or-prompt>`

## Evidence

Every run should leave:

- manifest path
- generated or source PDF path
- output workspace path
- summary JSON path
- artifact paths for semantic/OCR outputs
