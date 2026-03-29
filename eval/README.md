# Eval Harness

`echo-pdf` issue `#42` uses this directory as the local-first evaluation workspace.

What lives here:

- `manifests/`: suite definitions for `smoke`, `core`, `stress`, and `known-bad`
- `public-sources.json`: registry of public sample PDFs used by the suites
- `fetch-public-samples.mjs`: downloader that caches those public PDFs locally
- `prompts/`: OCR prompt variants used by the runner
- `samples/`: sample organization rules
- `examples/`: checked-in example outputs and handoff examples
- `run-local.mjs`: suite runner that executes local document, semantic-structure, and OCR evals

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
export ECHO_PDF_EVAL_OCR_PROVIDER=openai
export ECHO_PDF_EVAL_OCR_MODEL=gpt-4.1-mini
export OPENAI_API_KEY=...
npm run eval:core
```

Outputs:

- default summary path: `eval/out/<suite>-<timestamp>.summary.json`
- default workspace path: `eval/out/<suite>-<timestamp>.workspace/`
- generated PDFs for manifest-backed cases: `eval/out/<suite>-<timestamp>.generated/`
- cached public PDFs: `eval/public-samples/*.pdf`

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
