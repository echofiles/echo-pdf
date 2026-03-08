#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "${SCRIPT_DIR}/check-runtime.sh"

# Smoke now reuses integration tests as the single E2E source of truth.
# Supported env vars (forwarded to integration tests):
# - SMOKE_BASE_URL
# - SMOKE_REQUIRE_LLM
# - SMOKE_LLM_PROVIDER
# - SMOKE_LLM_MODEL
# - TESTCASE_DIR
npm run test:integration
