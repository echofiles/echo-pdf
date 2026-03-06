# Echo PDF Agent (Cloudflare Workers + MCP Server)

Workers-native PDF agent with MCP server and dynamic tool schema.

## Features

- `pdf_extract_pages`: render selected PDF pages to PNG (return mode: `inline`/`file_id`/`url`)
- `pdf_ocr_pages`: OCR selected pages via multimodal LLM
- `pdf_tables_to_latex`: table recognition to LaTeX
- `file_ops`: runtime file operations (`list/read/delete/put`)
- Single-source tool schema: same definitions power `/tools/catalog`, `/tools/call`, and MCP `tools/list`
- Session-only provider key input in UI (no persistence)
- Standard stream events: `meta/step/io/result/error/done`

## Run

```bash
cd /Users/huangjinfeng/workspace/echofiles/echo-pdf
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open <http://localhost:8787>.

## Config

- File: `echo-pdf.config.json`
- Optional override: `ECHO_PDF_CONFIG_JSON`

Provider model list is always fetched from provider `/models` API.

## API

- `GET /health`
- `GET /config`
- `GET /tools/catalog`
- `POST /tools/call`
- `POST /providers/models`
- `POST /api/agent/run`
- `POST /api/agent/stream`
- `POST /api/files/op`
- `POST /mcp`

## Test

```bash
npm run typecheck
npm run smoke
```

Smoke validates health/config/catalog/tool-call/file-ops/MCP tools list.
