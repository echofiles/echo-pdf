# Eval Playbook

## Scope

This playbook is for `echo-pdf` issue `#42` only.

Allowed:

- local eval suites
- local runner scaffolding
- evaluation docs
- run summaries
- issue handoff templates

Not allowed:

- product feature work
- public API changes
- MCP expansion
- SaaS control-plane work
- merge / close automation

## Evaluation Layers

Use four suites, in this order:

1. `smoke`
   Fast local sanity checks. No provider dependency.
2. `core`
   Representative provider-backed semantic-structure comparisons on stable cases.
3. `stress`
   Budget-sensitive and long-context semantic pressure cases.
4. `known-bad`
   Tracked unsupported patterns that should remain visible until fixed.

## Standard Flow

1. Run `npm run build`.
2. Run `npm run eval:smoke`.
3. If provider keys are available, run `npm run eval:core` and `npm run eval:stress`.
4. Run `npm run eval:known-bad`.
5. Inspect the generated summary JSON.
6. Produce an issue handoff when a run is `failed` or when a `known-bad` case flips to `unexpected-pass`.

Before those runs, cache the public PDFs locally:

```bash
npm run eval:fetch-public-samples
```

## Comparison Rules

Compare along explicit axes only:

- `semantic structure`
  - provider/model
  - model
  - chunk budget

Do not hide blocked provider runs. Report them as blocked.

## Promotion Rules

- `smoke` must stay deterministic and provider-free.
- `core` should prefer stable, representative knowledge/guidance documents over low-information marketing layouts.
- `stress` should isolate one pressure factor at a time on long, dense documents.
- `known-bad` should represent intentionally visible product gaps, not flaky infrastructure.
