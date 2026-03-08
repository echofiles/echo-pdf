# Development Notes

## Runtime requirement

- Node.js >= 20
- `npm run check:runtime`

## Local development

```bash
npm install
npm run dev
```

## Test commands

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test
npm run smoke
```

Notes:

- `smoke` reuses `test:integration` (compat alias)
- Integration tests read `../.env.local` automatically
- Integration/Smoke sample PDF priority:
  1. `TESTCASE_DIR` (default `../testcase/eda`) first PDF
  2. `scripts/fixtures/smoke.pdf`

Useful env vars:

- `SMOKE_BASE_URL` (test deployed service)
- `SMOKE_REQUIRE_LLM=1` (fail when no LLM key)
- `SMOKE_LLM_PROVIDER=openrouter|openai|vercel_gateway`
- `SMOKE_LLM_MODEL=<model-id>`
- `TESTCASE_DIR=<path>`

## Deploy

```bash
npm run deploy
```

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Optional for real LLM integration checks:

- `OPENAI_API_KEY`
- `OPENROUTER_KEY` / `OPENROUTER_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY` / `VERCEL_AI_GATEWAY_KEY`

## Publish

```bash
npm whoami
npm pack --dry-run
npm publish --access public
```
