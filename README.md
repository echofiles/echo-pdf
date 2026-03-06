# Echo PDF Agent (Cloudflare Workers + MCP)

面向 PDF 的在线 Agent 服务。部署后可直接通过 HTTP API、MCP、Web UI 使用。

## Online Service First

部署成功后，服务地址通常是：

- `https://echo-pdf-agent.<your-subdomain>.workers.dev`
- 或你绑定的自定义域名

以下示例使用：

```bash
export BASE_URL="https://echo-pdf-agent.<your-subdomain>.workers.dev"
```

## Core Capabilities

- `pdf_extract_pages`: 指定页渲染成图片（`inline`/`file_id`/`url`）
- `pdf_ocr_pages`: 指定页 OCR
- `pdf_tables_to_latex`: 表格识别转 LaTeX
- `file_ops`: 文件 list/read/delete/put
- `POST /mcp`: MCP server（`initialize`, `tools/list`, `tools/call`）

## Web UI (Deployed)

直接访问：

- `GET /`（部署域名根路径）

UI 支持：

- provider 与 model 动态加载
- session key 输入（不落库）
- PDF 直接上传（自动回填 `fileId`）
- tool schema 动态表单
- trace stream

## API (Deployed)

### Health / Config / Tool Catalog

```bash
curl -sS "$BASE_URL/health"
curl -sS "$BASE_URL/config"
curl -sS "$BASE_URL/tools/catalog"
```

### Upload PDF

```bash
curl -sS -X POST "$BASE_URL/api/files/upload" \
  -F "file=@./sample.pdf"
```

返回 `file.id` 后可在后续调用中使用。

### Extract Pages

```bash
curl -sS -X POST "$BASE_URL/tools/call" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"pdf_extract_pages",
    "arguments":{
      "fileId":"<file_id>",
      "pages":[1,2],
      "returnMode":"file_id"
    }
  }'
```

### OCR

```bash
curl -sS -X POST "$BASE_URL/tools/call" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"pdf_ocr_pages",
    "arguments":{
      "fileId":"<file_id>",
      "pages":[1],
      "provider":"openrouter",
      "model":"<vision_model>"
    }
  }'
```

### Stream Run

```bash
curl -sS -N -X POST "$BASE_URL/api/agent/stream" \
  -H "Content-Type: application/json" \
  -d '{"operation":"extract_pages","fileId":"<file_id>","pages":[1],"returnMode":"file_id"}'
```

## MCP Usage

端点：`POST /mcp`

- `initialize`
- `tools/list`
- `tools/call`

若配置了 `mcp.authHeader + mcp.authEnv`，调用 MCP 需带鉴权头。

## Deploy

```bash
npm install
npm run deploy
```

`wrangler.toml` 默认 worker 名称：`echo-pdf-agent`。

## Configuration

主配置：`echo-pdf.config.json`

可覆盖：`ECHO_PDF_CONFIG_JSON`

provider key 默认读取配置中的 `apiKeyEnv`。
当前默认：

- `OPENAI_API_KEY`
- `OPENROUTER_KEY`
- `VERCEL_AI_GATEWAY_KEY`

## CI/CD

- CI: `typecheck + smoke`
- CD: 部署前先校验 secrets

GitHub Actions 需要：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Local Development

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

本地地址：`http://127.0.0.1:8787`

## Tests

```bash
npm run typecheck
npm run smoke
```
