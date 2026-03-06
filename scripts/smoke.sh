#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8788}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE=".smoke-dev.log"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "${DEV_PID}" >/dev/null 2>&1; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

npm run dev -- --ip 127.0.0.1 --port "${PORT}" >"${LOG_FILE}" 2>&1 &
DEV_PID=$!

for _ in $(seq 1 50); do
  if curl -sS "${BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.4
done

curl -sS "${BASE_URL}/health" | rg -q '"ok":true'
curl -sS "${BASE_URL}/config" | rg -q '"capabilities"'
curl -sS "${BASE_URL}/tools/catalog" | rg -q '"pdf_extract_pages"'

PUT_RESULT=$(curl -sS -X POST "${BASE_URL}/api/files/op" \
  -H "Content-Type: application/json" \
  -d '{"op":"put","text":"hello-smoke","filename":"smoke.txt","mimeType":"text/plain","returnMode":"file_id"}')

FILE_ID=$(printf '%s' "$PUT_RESULT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [[ -z "$FILE_ID" ]]; then
  echo "failed to parse file id"
  exit 1
fi

curl -sS -X POST "${BASE_URL}/api/files/op" \
  -H "Content-Type: application/json" \
  -d "{\"op\":\"read\",\"fileId\":\"${FILE_ID}\",\"includeBase64\":false}" | rg -q 'hello-smoke'

curl -sS -X POST "${BASE_URL}/tools/call" \
  -H "Content-Type: application/json" \
  -d '{"name":"file_ops","arguments":{"op":"list"}}' | rg -q 'smoke.txt'

curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | rg -q 'pdf_ocr_pages'

curl -sS -X POST "${BASE_URL}/api/files/op" \
  -H "Content-Type: application/json" \
  -d "{\"op\":\"delete\",\"fileId\":\"${FILE_ID}\"}" | rg -q '"deleted":true'

echo "echo-pdf smoke test passed"
