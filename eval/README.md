# Eval Harness

`echo-pdf` issue `#42` uses this directory as the local-first evaluation workspace.

What lives here:

- `manifests/`: suite definitions for `smoke`, `core`, `stress`, and `known-bad`
- `fetch-public-samples.mjs`: downloader that hydrates the shared public sample cache
- `examples/`: checked-in example outputs and handoff examples
- `run-local.mjs`: suite runner that executes local document and semantic-structure evals

Shared sample ownership lives outside `eval/`:

- `samples/repo-owned/`: checked-in canonical PDFs used by release-gating tests
- `samples/public-cache/`: fetched public PDF cache shared by acceptance tests and eval suites
- `samples/public-sources.json`: registry of fetchable public PDFs

Quick start:

```bash
npm run eval:fetch-public-samples
npm run build
npm run eval:smoke
```

Provider-backed comparisons are optional and local-only. Set env vars before running `core` or `stress` suites:

```bash
export ECHO_PDF_EVAL_SEMANTIC_PROVIDER=openai
export ECHO_PDF_EVAL_SEMANTIC_MODEL=gpt-4.1-mini
export OPENAI_API_KEY=...
npm run eval:core
```

Outputs:

- default summary path: `eval/out/<suite>-<timestamp>.summary.json`
- default workspace path: `eval/out/<suite>-<timestamp>.workspace/`
- generated PDFs for manifest-backed cases: `eval/out/<suite>-<timestamp>.generated/`
- shared cached public PDFs: `samples/public-cache/*.pdf`
- daily growth collector output: `eval/out/daily-growth/daily-growth.json`
- daily growth collector Markdown: `eval/out/daily-growth/daily-growth.md`

Daily growth artifacts:

- `daily-growth.json`
  - `docsSite`: docs-site health and machine-consumable discovery signal collection
  - `npm`: registry visibility and version signal collection
  - `repo`: open issue/PR counts plus recent merged PRs and closed issues
  - `smoke`: minimal build/install/import/CLI smoke status from a fresh consumer
- `daily-growth.md`
  - human-readable rendering of the same collected signals
  - includes metric-meaning notes so operators can read the report without opening the JSON

The runner is intentionally local-first:

- no MCP
- no SaaS-specific control plane
- no merge/close automation
- no product/API changes

For operating rules and reporting format, use:

- `docs/EVAL_PLAYBOOK.md`
- `docs/EVAL_RUN_SUMMARY.md`
- `docs/EVAL_FAILURE_TAXONOMY.md`
- `docs/EVAL_ISSUE_HANDOFF.md`
- `docs/EVAL_SAMPLE_ORGANIZATION.md`
- `../samples/README.md`
