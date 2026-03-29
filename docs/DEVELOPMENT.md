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
- Do not mix Node-only code into Worker-only paths.
- If Node APIs are introduced, keep them in Node-specific modules or entrypoints.
- Do not solve boundary problems by injecting Node globals or Node types into the whole project.

## Validation Order

Always classify failures before changing code:

1. Static/build validation
   - `npm run check:runtime`
   - `npm run typecheck`
2. Unit tests
   - `npm run test:unit`
3. Integration tests
   - `npm run test:integration`
4. Full verification
   - `npm test`

Rules:

- Environment failures are not product conclusions.
- `bun` may help local diagnosis, but the repo is judged by the declared Node runtime and CI path.
- Port binding, system permissions, and local runtime mismatch must be reported as infra blockers, not hidden by code changes.

## Testing Policy

- No mocks unless explicitly approved.
- Integration tests should be env-gated when they require real providers or local services.
- Do not weaken product scope to make tests easier.
- Do not merge static, unit, and integration failures into one vague "test failed" statement. Report the layer.

## Local-First Development

- Prefer explicit local workflows over hosted assumptions.
- Local artifacts should be inspectable and reusable.
- Repeated local runs should reuse prior artifacts/workspace when reasonable.

## Pull Request Expectations

Every PR should state:

- which runtime boundary it touches: Node, Worker, or shared
- which validation layers were run
- which checks were blocked by infra, if any
- whether the change is a targeted fix or part of a greenfield rebuild

Keep PRs small and mergeable. Do not combine architecture migration, new product surface, and broad test rewrites unless the issue explicitly allows a rebuild.
