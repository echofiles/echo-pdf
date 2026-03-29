# [SEMANTIC_FORBIDDEN_SECTION] Heuristic promoted running headers in NIST guidance

## Context

- suite: `known-bad`
- runId: `known-bad::semantic::semantic-heuristic-baseline::public-guidance-nist-800-171-heuristic-running-header-noise`
- caseId: `public-guidance-nist-800-171-heuristic-running-header-noise`
- configId: `semantic-heuristic-baseline`
- local-only: `yes`

## Sample

- source kind: `existing`
- source path: `eval/public-samples/nist-sp-800-171r2.pdf`
- page(s): `14+`

## Reproduction

```bash
npm run build
node ./eval/run-local.mjs --suite known-bad
```

## Configuration

- semantic provider/model: `n/a`
- OCR provider/model: `n/a`
- prompt: `runtime semantic prompt`
- budget: `heuristic fallback`

## Expected

Running headers and page boilerplate should not be emitted as semantic sections.

## Actual

The semantic artifact emitted titles such as `CHAPTER ONE PAGE 1 This publication is available free of charge ...`, which are running headers rather than real sections.

## Taxonomy

- primary: `SEMANTIC_FORBIDDEN_SECTION`

## Severity

- `minor`

## Suggested Next Step

- Add header/footer suppression before heuristic heading detection or narrow the heuristic to reject repeated running-header patterns.
