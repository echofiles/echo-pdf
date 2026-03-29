# Shared Sample Assets

`samples/` is the repo-level sample layer shared by both gating tests and non-gating eval runs.

## Ownership Model

- `tests/`
  - release-gating verification
  - unit, integration, and acceptance confidence checks
- `eval/`
  - non-gating measurement, trend discovery, and issue handoff
- `samples/`
  - shared PDF asset ownership for both layers

## Sample Directories

- `samples/repo-owned/`
  - checked-in canonical PDFs that ship with the repo
  - stable local inputs for release-gating tests
- `samples/public-cache/`
  - fetched local cache of public/offical PDFs
  - not part of the product runtime
  - hydrated with `npm run eval:fetch-public-samples`
- `samples/public-sources.json`
  - registry of fetchable public PDFs and their stable local filenames

## Current Canonical Split

- repo-owned PDFs
  - `input.pdf`
  - `smoke.pdf`
- fetched public cache
  - `arxiv-attention-is-all-you-need.pdf`
  - `irs-form-w4.pdf`
  - `irs-publication-15t.pdf`
  - `cisa-infrastructure-resilience-planning-framework.pdf`
  - `nist-sp-800-171r2.pdf`

## Contributor Answers

- What is a gating test?
  - anything under `tests/`
- What is an eval?
  - a suite run under `eval/` for non-gating measurement
- Where do repo-owned sample PDFs live?
  - `samples/repo-owned/`
- Where do fetched public PDFs live?
  - `samples/public-cache/`
