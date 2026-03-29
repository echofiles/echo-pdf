# Failure Taxonomy

Use these codes in summaries and issue handoffs.

## Infra / Environment

- `ENV_PROVIDER_OR_MODEL_MISSING`
  Missing local provider/model selection for a provider-backed run.
- `ENV_PROVIDER_KEY_MISSING`
  Required API key env var is absent.
- `INFRA_REQUEST_TIMEOUT`
  Provider request timed out.
- `INFRA_PROVIDER_AUTH_FAILED`
  Provider auth failed.
- `INFRA_PROVIDER_RATE_LIMITED`
  Provider request was rate limited.

## Input / Sample

- `INPUT_PDF_INVALID`
  PDF could not be loaded or addressed.

## Document Layer

- `DOCUMENT_PAGE_COUNT_MISMATCH`
  Indexed page count diverged from expectation.

## Semantic Structure

- `SEMANTIC_MISSING_SECTION`
  Required section title / level / page was not present.
- `SEMANTIC_FORBIDDEN_SECTION`
  A forbidden section appeared.
- `SEMANTIC_UNDERSPECIFIED_STRUCTURE`
  Too few root sections were emitted.
- `SEMANTIC_HALLUCINATED_SECTION`
  Too many root sections were emitted.
- `SEMANTIC_FALLBACK_DRIFT`
  The detector path did not match the intended eval path.
- `SEMANTIC_MODEL_OUTPUT_INVALID`
  Provider output could not be parsed into the expected structure.

## Runner / Reporting

- `RUNNER_UNCLASSIFIED_ERROR`
  The harness failed outside known product or infra categories.

## Handoff Guidance

When filing an issue:

- one dominant code per issue title
- include secondary codes in the body only if they materially change debugging priority
- distinguish infra blockers from product failures
- keep `known-bad` codes visible until product behavior truly changes
