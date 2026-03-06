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

npm run dev -- --ip 127.0.0.1 --port "${PORT}" --inspector-port 0 >"${LOG_FILE}" 2>&1 &
DEV_PID=$!

for _ in $(seq 1 50); do
  if curl -sS "${BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.4
done

curl -sS "${BASE_URL}/health" | grep -q '"ok":true'
curl -sS "${BASE_URL}/config" | grep -q '"capabilities"'
curl -sS "${BASE_URL}/tools/catalog" | grep -q '"pdf_extract_pages"'

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
  -d "{\"op\":\"read\",\"fileId\":\"${FILE_ID}\",\"includeBase64\":false}" | grep -q 'hello-smoke'

curl -sS -X POST "${BASE_URL}/tools/call" \
  -H "Content-Type: application/json" \
  -d '{"name":"file_ops","arguments":{"op":"list"}}' | grep -q 'smoke.txt'

curl -sS -X POST "${BASE_URL}/tools/call" \
  -H "Content-Type: application/json" \
  -d '{"name":"pdf_extract_pages","arguments":{"url":"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf","pages":[1],"returnMode":"file_id"}}' | grep -q '"images"'

curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' | grep -q '"serverInfo"'

curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -q 'pdf_ocr_pages'

curl -sS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"file_ops","arguments":{"op":"list"}}}' | grep -q '"content"'

curl -sS -X POST "${BASE_URL}/api/files/op" \
  -H "Content-Type: application/json" \
  -d "{\"op\":\"delete\",\"fileId\":\"${FILE_ID}\"}" | grep -q '"deleted":true'

echo "echo-pdf smoke test passed"
