# [SEMANTIC_FORBIDDEN_SECTION] Provider-backed semantic extraction promoted running headers in NIST guidance

## Context

- suite: `known-bad`
- runId: `known-bad::semantic::semantic-agent-standard::public-guidance-nist-800-171-semantic-running-header-noise`
- caseId: `public-guidance-nist-800-171-semantic-running-header-noise`
- configId: `semantic-agent-standard`
- local-only: `yes`

## Sample

- source kind: `existing`
- source path: `samples/public-cache/nist-sp-800-171r2.pdf`
- page(s): `14+`

## Reproduction

```bash
bun run build
node ./eval/run-local.mjs --suite known-bad
```

## Configuration

- semantic provider/model: `provider-backed`
- prompt: `runtime semantic prompt`
- budget: `standard`

## Expected

Running headers and page boilerplate should not be emitted as semantic sections.

## Actual

The semantic artifact emitted titles such as `CHAPTER ONE PAGE 1 This publication is available free of charge ...`, which are running headers rather than real sections.

## Taxonomy

- primary: `SEMANTIC_FORBIDDEN_SECTION`

## Severity

- `minor`

## Suggested Next Step

- Tighten the provider-backed semantic prompt/path so repeated running-header text is rejected before section assembly.
