#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="${PORT:-8788}"
BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:${PORT}}"
LOG_FILE="${LOG_FILE:-.smoke-dev.log}"
FIXTURE_PDF="${FIXTURE_PDF:-${SCRIPT_DIR}/fixtures/smoke.pdf}"
SMOKE_REQUIRE_LLM="${SMOKE_REQUIRE_LLM:-0}"
START_LOCAL_DEV=1
[[ -n "${SMOKE_BASE_URL:-}" ]] && START_LOCAL_DEV=0

if [[ -f "${ROOT_DIR}/../.env.local" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/../.env.local"
  set +a
fi

bash "${SCRIPT_DIR}/check-runtime.sh"

if [[ ! -f "${FIXTURE_PDF}" ]]; then
  echo "missing fixture pdf: ${FIXTURE_PDF}"
  exit 1
fi

assert_json_expr() {
  local json_payload="$1"
  local expression="$2"
  local message="$3"
  printf '%s' "${json_payload}" | node -e '
    const fs = require("node:fs")
    const input = fs.readFileSync(0, "utf8")
    const payload = JSON.parse(input)
    const expr = process.argv[1]
    const message = process.argv[2]
    const result = Function("j", `return (${expr})`)(payload)
    if (!result) {
      console.error(`assert failed: ${message}`)
      console.error(input)
      process.exit(1)
    }
  ' "${expression}" "${message}"
}

json_get() {
  local json_payload="$1"
  local expression="$2"
  printf '%s' "${json_payload}" | node -e '
    const fs = require("node:fs")
    const input = fs.readFileSync(0, "utf8")
    const payload = JSON.parse(input)
    const expr = process.argv[1]
    const value = Function("j", `return (${expr})`)(payload)
    if (value === undefined || value === null) process.exit(0)
    if (typeof value === "string") process.stdout.write(value)
    else process.stdout.write(String(value))
  ' "${expression}"
}

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "${DEV_PID}" >/dev/null 2>&1; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${START_LOCAL_DEV}" == "1" ]]; then
  npm run dev -- --ip 127.0.0.1 --port "${PORT}" --inspector-port 0 >"${LOG_FILE}" 2>&1 &
  DEV_PID=$!

  ready=0
  for _ in $(seq 1 80); do
    if curl -sS "${BASE_URL}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [[ "${ready}" != "1" ]]; then
    echo "dev server did not become ready: ${BASE_URL}"
    tail -n 120 "${LOG_FILE}" || true
    exit 1
  fi
fi

HEALTH="$(curl -sS "${BASE_URL}/health")"
assert_json_expr "${HEALTH}" "j.ok === true" "health.ok must be true"

CONFIG="$(curl -sS "${BASE_URL}/config")"
assert_json_expr "${CONFIG}" "typeof j.agent?.defaultProvider === 'string' && j.agent.defaultProvider.length > 0" "config default provider missing"
assert_json_expr "${CONFIG}" "Array.isArray(j.providers) && j.providers.length > 0" "config providers should not be empty"

TOOLS="$(curl -sS "${BASE_URL}/tools/catalog")"
assert_json_expr "${TOOLS}" "Array.isArray(j.tools) && j.tools.some((t) => t.name === 'pdf_extract_pages')" "missing tool pdf_extract_pages"
assert_json_expr "${TOOLS}" "Array.isArray(j.tools) && j.tools.some((t) => t.name === 'pdf_ocr_pages')" "missing tool pdf_ocr_pages"
assert_json_expr "${TOOLS}" "Array.isArray(j.tools) && j.tools.some((t) => t.name === 'pdf_tables_to_latex')" "missing tool pdf_tables_to_latex"
assert_json_expr "${TOOLS}" "Array.isArray(j.tools) && j.tools.some((t) => t.name === 'file_ops')" "missing tool file_ops"

UPLOAD_RESULT="$(curl -sS -X POST "${BASE_URL}/api/files/upload" -F "file=@${FIXTURE_PDF};type=application/pdf")"
FILE_ID="$(json_get "${UPLOAD_RESULT}" "j.file && j.file.id ? j.file.id : ''")"
if [[ -z "${FILE_ID}" ]]; then
  echo "upload response missing file id"
  echo "${UPLOAD_RESULT}"
  exit 1
fi

READ_RESULT="$(curl -sS -X POST "${BASE_URL}/api/files/op" \
  -H "Content-Type: application/json" \
  -d "{\"op\":\"read\",\"fileId\":\"${FILE_ID}\",\"includeBase64\":false}")"
assert_json_expr "${READ_RESULT}" "j.file && j.file.id === '${FILE_ID}'" "file read should return uploaded file id"

LIST_RESULT="$(curl -sS -X POST "${BASE_URL}/tools/call" \
  -H "Content-Type: application/json" \
  -d '{"name":"file_ops","arguments":{"op":"list"}}')"
assert_json_expr "${LIST_RESULT}" "Array.isArray(j.output?.files) && j.output.files.some((f) => f.id === '${FILE_ID}')" "file_ops list missing uploaded file"

EXTRACT_RESULT="$(curl -sS -X POST "${BASE_URL}/tools/call" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"pdf_extract_pages\",\"arguments\":{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"returnMode\":\"inline\"}}")"
assert_json_expr "${EXTRACT_RESULT}" "Array.isArray(j.output?.images) && j.output.images.length > 0" "extract should return images"
assert_json_expr "${EXTRACT_RESULT}" "typeof j.output.images[0].data === 'string' && j.output.images[0].data.startsWith('data:image/png;base64,')" "extract inline image should be data URL"

STREAM_RESULT="$(curl -sS -N -X POST "${BASE_URL}/api/agent/stream" \
  -H "Content-Type: application/json" \
  -d "{\"operation\":\"extract_pages\",\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"returnMode\":\"inline\"}")"
printf '%s' "${STREAM_RESULT}" | grep -q 'event: done'
printf '%s' "${STREAM_RESULT}" | grep -q '"ok":true'
printf '%s' "${STREAM_RESULT}" | grep -q 'event: result'

MCP_INIT="$(curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}')"
assert_json_expr "${MCP_INIT}" "j.result && j.result.serverInfo && typeof j.result.serverInfo.name === 'string'" "mcp initialize missing serverInfo"

MCP_TOOLS="$(curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
assert_json_expr "${MCP_TOOLS}" "Array.isArray(j.result?.tools) && j.result.tools.some((t) => t.name === 'pdf_ocr_pages')" "mcp tools/list missing pdf_ocr_pages"

MCP_CALL="$(curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"file_ops","arguments":{"op":"list"}}}')"
assert_json_expr "${MCP_CALL}" "Array.isArray(j.result?.content)" "mcp tools/call missing content"

LLM_PROVIDER=""
if [[ -n "${OPENROUTER_KEY:-}" ]]; then
  LLM_PROVIDER="openrouter"
elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
  LLM_PROVIDER="openai"
elif [[ -n "${VERCEL_AI_GATEWAY_KEY:-}" ]]; then
  LLM_PROVIDER="vercel_gateway"
fi

if [[ -n "${LLM_PROVIDER}" ]]; then
  PROVIDER_KEYS_JSON="$(cat <<JSON
{"openai":"${OPENAI_API_KEY:-}","openrouter":"${OPENROUTER_KEY:-}","vercel-ai-gateway":"${VERCEL_AI_GATEWAY_KEY:-}"}
JSON
)"
  MODELS_RESULT="$(curl -sS -X POST "${BASE_URL}/providers/models" \
    -H "Content-Type: application/json" \
    -d "{\"provider\":\"${LLM_PROVIDER}\",\"providerApiKeys\":${PROVIDER_KEYS_JSON}}")"
  assert_json_expr "${MODELS_RESULT}" "Array.isArray(j.models) && j.models.length > 0" "provider models should not be empty for ${LLM_PROVIDER}"
  LLM_MODEL="$(json_get "${MODELS_RESULT}" "j.models[0] || ''")"
  if [[ -z "${LLM_MODEL}" ]]; then
    echo "failed to resolve model for provider ${LLM_PROVIDER}"
    echo "${MODELS_RESULT}"
    exit 1
  fi

  OCR_RESULT="$(curl -sS -X POST "${BASE_URL}/tools/call" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"pdf_ocr_pages\",\"arguments\":{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"provider\":\"${LLM_PROVIDER}\",\"model\":\"${LLM_MODEL}\"},\"provider\":\"${LLM_PROVIDER}\",\"model\":\"${LLM_MODEL}\",\"providerApiKeys\":${PROVIDER_KEYS_JSON}}")"
  assert_json_expr "${OCR_RESULT}" "Array.isArray(j.output?.pages) && j.output.pages.length > 0" "ocr should return at least one page"
  assert_json_expr "${OCR_RESULT}" "typeof j.output.pages[0].text === 'string'" "ocr page text should be string"
  echo "llm integration check passed: provider=${LLM_PROVIDER}, model=${LLM_MODEL}"
elif [[ "${SMOKE_REQUIRE_LLM}" == "1" ]]; then
  echo "SMOKE_REQUIRE_LLM=1 but no provider key found."
  exit 1
else
  echo "llm integration check skipped: no provider key configured."
fi

DELETE_RESULT="$(curl -sS -X POST "${BASE_URL}/api/files/op" \
  -H "Content-Type: application/json" \
  -d "{\"op\":\"delete\",\"fileId\":\"${FILE_ID}\"}")"
assert_json_expr "${DELETE_RESULT}" "j.deleted === true" "file delete should return true"

STATS_RESULT="$(curl -sS "${BASE_URL}/api/files/stats")"
assert_json_expr "${STATS_RESULT}" "typeof j.stats?.totalBytes === 'number'" "file stats missing totalBytes"

CLEANUP_RESULT="$(curl -sS -X POST "${BASE_URL}/api/files/cleanup")"
assert_json_expr "${CLEANUP_RESULT}" "typeof j.deletedExpired === 'number'" "cleanup missing deletedExpired"

echo "echo-pdf smoke test passed"
