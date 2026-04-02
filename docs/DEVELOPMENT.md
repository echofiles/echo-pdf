# Development Notes

## Current Direction

`echo-pdf` is now a local-first document component core.

Product positioning lives in [`docs/PRODUCT.md`](./PRODUCT.md). Development choices should follow that product boundary first, then the implementation constraints below.

Priority in this phase:

- local CLI
- local library/client API
- local artifacts/workspace
- document context primitives such as `get_document`, `get_document_structure`, and `get_page_content`

Deferred in this phase:

- MCP expansion
- hosted SaaS / platform work
- domain-specific extraction logic

If the current internal structure becomes more expensive than rebuilding, a greenfield rebuild inside this repo is allowed. Preserve the repo identity and product boundary.

## Runtime Boundaries

- Node.js `>= 20` is the baseline runtime. Do not treat older local Node versions as a repo bug.
- Keep Node-only code inside the documented local runtime boundary.
- Do not solve boundary problems by injecting Node globals or Node types into the whole project.

## Validation Order

Always classify failures before changing code:

1. Static/build validation
   - `bun run check:runtime`
   - `bun run typecheck`
2. Unit tests
   - `bun run test:unit`
3. Integration tests
   - `bun run test:integration`
4. Full verification
   - `bun run test`

Rules:

- Environment failures are not product conclusions.
- `bun` may help local diagnosis, but the repo is judged by the declared Node runtime and CI path.
- Port binding, system permissions, and local runtime mismatch must be reported as infra blockers, not hidden by code changes.

## Testing Policy

- No mocks unless explicitly approved.
- Integration tests should be env-gated when they require real providers.
- Do not weaken product scope to make tests easier.
- Do not merge static, unit, and integration failures into one vague "test failed" statement. Report the layer.

## Testing Architecture

- `tests/unit/`
  - fast gating checks for local logic
- `tests/integration/`
  - gating checks for packaging, runtime, CLI, and built-path behavior
- `tests/acceptance/`
  - a small number of high-value product gates on canonical real PDFs
- `eval/`
  - non-gating measurement, trend discovery, and issue handoff

Shared sample ownership is repo-level:

- `samples/repo-owned/`
  - checked-in canonical PDFs for gating paths
- `samples/public-cache/`
  - fetched local cache of public PDFs shared by acceptance and eval
- `samples/public-sources.json`
  - fetch registry for the shared public cache

## Local-First Development

- Prefer explicit local workflows over hosted assumptions.
- Local artifacts should be inspectable and reusable.
- Repeated local runs should reuse prior artifacts/workspace when reasonable.
- Repo-internal source-checkout CLI debugging can use `bun run cli:dev -- <primitive> ...`.
- `cli:dev` is an internal development helper only, not part of the public CLI/documentation surface.
- Eval operations for issue `#42` live under `eval/` and `docs/EVAL_*.md`.

## Local LLM Providers

- `echo-pdf` already speaks OpenAI-compatible HTTP for provider-backed semantic extraction.
- Local servers such as Ollama, llama.cpp, vLLM, LM Studio, and LocalAI can be configured by adding a provider with a localhost `baseUrl`.
- For no-auth local servers, leave `apiKeyEnv` empty in `echo-pdf.config.json`; the runtime will skip the `Authorization` header instead of requiring a dummy key.
- Example CLI flow:
  - `echo-pdf provider set --provider ollama --api-key ""`
  - `echo-pdf model set --provider ollama --model llava:13b`
  - `echo-pdf semantic ./sample.pdf --provider ollama`
- Semantic extraction still requires a vision-capable model. If the local model does not support image input, the provider error should propagate to the caller.

## Pull Request Expectations

Every PR should state:

- which runtime boundary it touches: Node local runtime or shared support code
- which validation layers were run
- which checks were blocked by infra, if any
- whether the change is a targeted fix or part of a greenfield rebuild

Keep PRs small and mergeable. Do not combine architecture migration, new product surface, and broad test rewrites unless the issue explicitly allows a rebuild.
