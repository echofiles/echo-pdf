#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/fixtures/output"
EXPORT_PORT="${EXPORT_PORT:-8798}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${EXPORT_PORT}}"
INPUT_PDF="${INPUT_PDF:-${ROOT_DIR}/fixtures/input.pdf}"
START_LOCAL_DEV="${START_LOCAL_DEV:-1}"
RUN_TABLES="${RUN_TABLES:-1}"
REQUIRE_LLM_SUCCESS="${REQUIRE_LLM_SUCCESS:-1}"

mkdir -p "$OUT_DIR"
rm -rf "${OUT_DIR:?}/"*

if [[ -f "${ROOT_DIR}/../.env.local" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/../.env.local"
  set +a
fi

if [[ ! -f "${INPUT_PDF}" ]]; then
  echo "missing input pdf: ${INPUT_PDF}" >&2
  exit 1
fi

cli() {
  node "${ROOT_DIR}/bin/echo-pdf.js" "$@"
}

run_json() {
  local name="$1"
  shift
  if "$@" > "${OUT_DIR}/${name}.json" 2> "${OUT_DIR}/${name}.err"; then
    rm -f "${OUT_DIR}/${name}.err"
  else
    printf '{"ok":false,"error_file":"%s.err"}\n' "$name" > "${OUT_DIR}/${name}.json"
  fi
}

build_model_candidates() {
  local models_json="$1"
  node -e 'const fs=require("fs");const p=process.argv[1];const forced=(process.env.SMOKE_LLM_MODEL||"").trim();const j=JSON.parse(fs.readFileSync(p,"utf8"));const models=Array.isArray(j.models)?j.models:[];const pick=(re)=>models.filter((m)=>re.test(String(m)));const preferred=[];if(forced)preferred.push(forced);const patterns=[/gpt-4o/i,/gpt-4\.1/i,/gpt-5/i,/claude-3\.[57]|claude-sonnet-4|claude-opus-4/i,/gemini-2\.5|gemini-3/i,/grok-2-vision|vision|vl/i,/pixtral/i,/qwen.*vl/i];for(const re of patterns){for(const m of pick(re)){if(!preferred.includes(m))preferred.push(m);}}for(const m of models){if(!preferred.includes(m))preferred.push(m);}process.stdout.write(JSON.stringify(preferred.slice(0,24)));' "$models_json"
}

validate_ocr_json() {
  local json_file="$1"
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const pages=j?.output?.pages;if(!Array.isArray(pages)||pages.length===0)process.exit(1);const t=String(pages[0]?.text||"").trim();if(t.length===0)process.exit(1);' "$json_file"
}

validate_tables_json() {
  local json_file="$1"
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const pages=j?.output?.pages;if(!Array.isArray(pages)||pages.length===0)process.exit(1);const t=String(pages[0]?.latex||"").trim();if(t.length===0)process.exit(1);' "$json_file"
}

# 1) Save test logs locally (do not block artifact export on transient network failure)
set +e
{
  echo "[typecheck]"
  npm --prefix "$ROOT_DIR" run typecheck
  TYPECHECK_CODE=$?
  echo
  echo "[test]"
  npm --prefix "$ROOT_DIR" run test
  TEST_CODE=$?
  echo
  echo "[smoke]"
  npm --prefix "$ROOT_DIR" run smoke
  SMOKE_CODE=$?
  echo
  echo "typecheck_exit=${TYPECHECK_CODE}"
  echo "test_exit=${TEST_CODE}"
  echo "smoke_exit=${SMOKE_CODE}"
} > "${OUT_DIR}/test.log" 2>&1
set -e

cat > "${OUT_DIR}/test-status.json" <<JSON
{"typecheck":${TYPECHECK_CODE:-1},"test":${TEST_CODE:-1},"smoke":${SMOKE_CODE:-1}}
JSON

DEV_PID=""
cleanup() {
  if [[ -n "${DEV_PID}" ]] && kill -0 "${DEV_PID}" >/dev/null 2>&1; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${START_LOCAL_DEV}" == "1" ]]; then
  npm --prefix "$ROOT_DIR" run dev -- --ip 127.0.0.1 --port "${EXPORT_PORT}" --inspector-port 0 > "${OUT_DIR}/export-local-dev.log" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 120); do
    if node -e 'fetch(process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "${BASE_URL}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  node -e 'fetch(process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "${BASE_URL}" >/dev/null
fi

# 2) Init CLI + provider settings
cli init --service-url "$BASE_URL" > "${OUT_DIR}/cli-init.json"

node -e 'const fs=require("fs");const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const entries=Object.entries(cfg.providers||{});const pick=(key)=>{const keys=[key];if(key.endsWith("_API_KEY"))keys.push(key.replace(/_API_KEY$/,"_KEY"));if(key.endsWith("_KEY"))keys.push(key.replace(/_KEY$/,"_API_KEY"));for(const k of keys){const v=process.env[k];if(typeof v==="string"&&v.trim())return {k,v:v.trim()};}return null;};const forced=String(process.env.SMOKE_LLM_PROVIDER||"").trim();if(forced&&cfg.providers?.[forced]){const found=pick(String(cfg.providers[forced].apiKeyEnv||""));if(found){process.stdout.write(JSON.stringify({provider:forced,apiKey:found.v,env:found.k,forced:true}));process.exit(0);}}const preferred=String(cfg.agent?.defaultProvider||"");const ordered=entries.sort((a,b)=>a[0]===preferred?-1:b[0]===preferred?1:0);for(const [alias,p] of ordered){const found=pick(String(p.apiKeyEnv||""));if(found){process.stdout.write(JSON.stringify({provider:alias,apiKey:found.v,env:found.k,forced:false}));process.exit(0);}}process.stdout.write(JSON.stringify({provider:preferred||"",apiKey:"",env:"",forced:false}));' "${ROOT_DIR}/echo-pdf.config.json" > "${OUT_DIR}/provider-selection.json"
PROVIDER="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.provider||""))' "${OUT_DIR}/provider-selection.json")"
PROVIDER_KEY="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.apiKey||""))' "${OUT_DIR}/provider-selection.json")"
if [[ -n "${PROVIDER}" ]] && [[ -n "${PROVIDER_KEY}" ]]; then
  cli provider set --provider "${PROVIDER}" --api-key "${PROVIDER_KEY}" > "${OUT_DIR}/provider-set.json"
  cli provider use --provider "${PROVIDER}" > "${OUT_DIR}/provider-use.json"
else
  echo '{"warning":"No provider key found in env, LLM calls may fail"}' > "${OUT_DIR}/provider-warning.json"
fi

# 3) Pull models via CLI and select one
if [[ -n "${PROVIDER}" ]]; then
  run_json "models" cli models --provider "${PROVIDER}"
else
  echo '{"warning":"No provider selected, skip model list"}' > "${OUT_DIR}/models.json"
fi
MODEL="$(node -e 'const fs=require("fs");const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,"utf8"));const m=Array.isArray(j.models)&&j.models[0]?j.models[0]:"";process.stdout.write(m)}catch{process.stdout.write("")}' "${OUT_DIR}/models.json")"
build_model_candidates "${OUT_DIR}/models.json" > "${OUT_DIR}/model-candidates.json"
if [[ -n "$MODEL" ]] && [[ -n "${PROVIDER}" ]]; then
  cli model set --provider "${PROVIDER}" --model "$MODEL" > "${OUT_DIR}/model-set.json"
else
  echo '{"warning":"No model available from selected provider"}' > "${OUT_DIR}/model-warning.json"
fi

# 4) Upload the exact local fixture for subsequent CLI/MCP calls
node -e 'const fs=require("fs"); const path=require("path"); (async()=>{ const base=process.argv[1]; const file=process.argv[2]; const bytes=fs.readFileSync(file); const fd=new FormData(); fd.set("file", new Blob([bytes], {type:"application/pdf"}), path.basename(file)); const res=await fetch(`${base}/api/files/upload`, {method:"POST", body:fd}); const txt=await res.text(); fs.writeFileSync(process.argv[3], txt); if(!res.ok){process.stderr.write(txt); process.exit(1);} })().catch((e)=>{console.error(String(e)); process.exit(1)})' "$BASE_URL" "$INPUT_PDF" "${OUT_DIR}/upload.json"
FILE_ID="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.file?.id||"")' "${OUT_DIR}/upload.json")"
if [[ -z "${FILE_ID}" ]]; then
  echo "upload did not return file id" >&2
  exit 1
fi

# 5) CLI tool calls
run_json "tools-catalog" cli tools
if [[ -n "${PROVIDER}" ]]; then
  run_json "cli-extract-pages" cli call --tool pdf_extract_pages --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"returnMode\":\"inline\"}" --provider "${PROVIDER}" --model "${MODEL:-}"
else
  run_json "cli-extract-pages" cli call --tool pdf_extract_pages --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"returnMode\":\"inline\"}"
fi
node -e 'const fs=require("fs");const p=process.argv[1];const out=process.argv[2];const j=JSON.parse(fs.readFileSync(p,"utf8"));const d=j.output?.images?.[0]?.data||"";if(!d.startsWith("data:image/"))process.exit(1);fs.writeFileSync(out, Buffer.from(d.split(",")[1]||"","base64"));' "${OUT_DIR}/cli-extract-pages.json" "${OUT_DIR}/page-1-cli.png"

# 6) MCP tool calls
run_json "mcp-initialize" cli mcp initialize
run_json "mcp-tools" cli mcp tools
run_json "mcp-call-fileops" cli mcp call --tool file_ops --args '{"op":"list"}'
run_json "mcp-extract-pages" cli mcp call --tool pdf_extract_pages --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"returnMode\":\"inline\"}"

# 7) LLM tool calls
OCR_OK=0
TABLES_OK=0
if [[ -n "${PROVIDER}" ]]; then
  : > "${OUT_DIR}/llm-attempts.log"
  while IFS= read -r CANDIDATE; do
    [[ -z "${CANDIDATE}" ]] && continue
    echo "[ocr] trying model=${CANDIDATE}" >> "${OUT_DIR}/llm-attempts.log"
    if cli call --tool pdf_ocr_pages --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"provider\":\"${PROVIDER}\",\"model\":\"${CANDIDATE}\"}" --provider "${PROVIDER}" --model "${CANDIDATE}" > "${OUT_DIR}/cli-ocr-pages.json" 2> "${OUT_DIR}/cli-ocr-pages.err"; then
      if validate_ocr_json "${OUT_DIR}/cli-ocr-pages.json"; then
        OCR_OK=1
        echo "{\"provider\":\"${PROVIDER}\",\"model\":\"${CANDIDATE}\"}" > "${OUT_DIR}/ocr-selected-model.json"
        break
      fi
    fi
  done < <(node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const m of (Array.isArray(a)?a:[])){console.log(m)}' "${OUT_DIR}/model-candidates.json")
else
  run_json "cli-ocr-pages" cli call --tool pdf_ocr_pages --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1]}"
fi

if [[ "${RUN_TABLES}" == "1" ]]; then
  if [[ -n "${PROVIDER}" ]]; then
    while IFS= read -r CANDIDATE; do
      [[ -z "${CANDIDATE}" ]] && continue
      echo "[tables] trying model=${CANDIDATE}" >> "${OUT_DIR}/llm-attempts.log"
      if cli call --tool pdf_tables_to_latex --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1],\"provider\":\"${PROVIDER}\",\"model\":\"${CANDIDATE}\"}" --provider "${PROVIDER}" --model "${CANDIDATE}" > "${OUT_DIR}/cli-tables-to-latex.json" 2> "${OUT_DIR}/cli-tables-to-latex.err"; then
        if validate_tables_json "${OUT_DIR}/cli-tables-to-latex.json"; then
          TABLES_OK=1
          echo "{\"provider\":\"${PROVIDER}\",\"model\":\"${CANDIDATE}\"}" > "${OUT_DIR}/tables-selected-model.json"
          break
        fi
      fi
    done < <(node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const m of (Array.isArray(a)?a:[])){console.log(m)}' "${OUT_DIR}/model-candidates.json")
  else
    run_json "cli-tables-to-latex" cli call --tool pdf_tables_to_latex --args "{\"fileId\":\"${FILE_ID}\",\"pages\":[1]}"
  fi
else
  echo '{"skipped":true,"reason":"Set RUN_TABLES=1 to enable table-latex call"}' > "${OUT_DIR}/cli-tables-to-latex.json"
fi

if [[ "${REQUIRE_LLM_SUCCESS}" == "1" ]]; then
  if [[ "${OCR_OK}" != "1" ]]; then
    echo "OCR failed for all candidate models. See ${OUT_DIR}/cli-ocr-pages.err and llm-attempts.log" >&2
    exit 1
  fi
  if [[ "${RUN_TABLES}" == "1" ]] && [[ "${TABLES_OK}" != "1" ]]; then
    echo "Tables failed for all candidate models. See ${OUT_DIR}/cli-tables-to-latex.err and llm-attempts.log" >&2
    exit 1
  fi
fi

cat > "${OUT_DIR}/summary.txt" <<TXT
base_url=${BASE_URL}
input_pdf=${INPUT_PDF}
file_id=${FILE_ID}
model=${MODEL}
outputs_dir=${OUT_DIR}
TXT

ls -la "$OUT_DIR"
