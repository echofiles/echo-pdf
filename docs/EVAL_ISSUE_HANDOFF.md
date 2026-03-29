# Issue Handoff Template

Use this template when a suite run produces `failed` or `unexpected-pass`.

```md
# [<taxonomy code>] <short failure title>

## Context

- suite: `<smoke|core|stress|known-bad>`
- runId: `<suite::kind::config::case>`
- caseId: `<case id>`
- configId: `<config id>`
- local-only: `yes`

## Sample

- source kind: `<existing|generated>`
- source path: `<absolute or repo-relative path>`
- page(s): `<page numbers>`

## Reproduction

```bash
npm run build
node ./eval/run-local.mjs --suite <suite>
```

## Configuration

- semantic provider/model: `<if applicable>`
- OCR provider/model: `<if applicable>`
- prompt: `<prompt file or hash>`
- budget: `<chunk budget or render scale>`

## Expected

Describe the expected structure or OCR behavior.

## Actual

Describe the actual output and cite the summary/artifact paths.

## Taxonomy

- primary: `<failure code>`
- secondary: `<optional failure code>`

## Severity

- `<blocking|major|minor>`

## Suggested Next Step

- `<implementation owner action>`
```
