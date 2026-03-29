# Run Summary Format

The local runner writes `echo-pdf.eval.run-summary.v1`.

Top-level fields:

- `summaryVersion`
- `generatedAt`
- `suite`
- `environment`
- `totals`
- `representativeRuns`
- `runs`

## `suite`

- `suiteId`
- `description`
- `manifestPath`

## `environment`

- runtime context: `node`, `platform`, `arch`
- local paths: `cwd`, `repoRoot`, `workspaceDir`
- env hints for semantic provider and model selection

## `totals`

- `caseCount`
- `runCount`
- `statuses`
- `taxonomyCounts`

Status buckets:

- `passed`
- `failed`
- `blocked`
- `known-bad`
- `unexpected-pass`

## Per-run record

Each `runs[]` item contains:

- `runId`
- `suiteId`
- `caseId`
- `kind`
- `configId`
- `status`
- `durationMs`
- `source`
- `config`
- `metrics`
- `failures`
- `artifacts`
- `notes`

`kind` is one of:

- `document`
- `semantic`

`source.kind` is one of:

- `existing`
- `generated`

## Interpretation

- `passed`: expectations matched
- `failed`: expectations missed or an unexpected runtime failure occurred
- `blocked`: missing local prerequisites such as provider/model/API key
- `known-bad`: failure happened exactly where the suite says the product is still weak
- `unexpected-pass`: a known-bad case no longer fails; docs or manifests likely need an update
