# Echo PDF Agent (Cloudflare Workers + MCP)

部署后可直接作为在线 PDF Agent 服务，支持三种使用方式：Web UI、HTTP API、MCP。

## 1. 不同用户怎么用

### A. 产品/运营用户（Web UI）

适合：手工上传 PDF、点选工具、查看 trace 与结果。

1. 打开部署地址根路径：`GET /`
2. 选择 Provider/Model（或使用默认）
3. 上传 PDF（自动得到 `fileId`）
4. 运行 `pdf_extract_pages` / `pdf_ocr_pages` / `pdf_tables_to_latex`

### B. 后端/数据工程（HTTP API）

适合：服务端自动化调用，和你现有系统对接。

1. `POST /api/files/upload` 上传文件
2. `POST /tools/call` 执行工具
3. `POST /api/agent/stream` 获取流式 step/io/result

### C. Agent 平台开发者（MCP Client）

适合：把 echo-pdf 当外部 MCP 工具服务接入 Agent。

1. `POST /mcp` 调 `initialize`
2. `POST /mcp` 调 `tools/list`
3. `POST /mcp` 调 `tools/call`

## 2. 部署后的服务地址

```bash
export BASE_URL="https://echo-pdf-agent.<your-subdomain>.workers.dev"
```

## 3. HTTP API 快速示例

### 3.1 Health / Config / Catalog

```bash
curl -sS "$BASE_URL/health"
curl -sS "$BASE_URL/config"
curl -sS "$BASE_URL/tools/catalog"
curl -sS "$BASE_URL/api/files/stats"
```

### 3.2 上传 PDF

```bash
curl -sS -X POST "$BASE_URL/api/files/upload" \
  -F "file=@./sample.pdf"
```

### 3.3 调工具

```bash
curl -sS -X POST "$BASE_URL/tools/call" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"pdf_extract_pages",
    "arguments":{
      "fileId":"<file_id>",
      "pages":[1],
      "returnMode":"file_id"
    }
  }'
```

### 3.5 存储清理（手动触发）

```bash
curl -sS -X POST "$BASE_URL/api/files/cleanup"
```

### 3.4 流式执行

```bash
curl -sS -N -X POST "$BASE_URL/api/agent/stream" \
  -H "Content-Type: application/json" \
  -d '{"operation":"extract_pages","fileId":"<file_id>","pages":[1],"returnMode":"file_id"}'
```

## 4. MCP 使用说明

端点：`POST /mcp`

### 4.1 initialize

```bash
curl -sS -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

### 4.2 tools/list

```bash
curl -sS -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### 4.3 tools/call

```bash
curl -sS -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"file_ops","arguments":{"op":"list"}}}'
```

若配置了 `mcp.authHeader + mcp.authEnv`，调用 MCP 时要带对应请求头。

## 5. 工具列表

- `pdf_extract_pages`
- `pdf_ocr_pages`
- `pdf_tables_to_latex`
- `file_ops`

说明：`pdf_*` 工具默认继承主 provider/model（可在请求顶层传入覆盖）。

## 6. 测试覆盖（含 MCP）

```bash
npm run typecheck
npm run smoke
```

当前 smoke 覆盖：

- `health/config/tools/catalog`
- `file_ops` put/read/delete
- `pdf_extract_pages`
- MCP `initialize/tools/list/tools/call`

## 7. 配置与部署

### 配置

- 主配置：`echo-pdf.config.json`
- 可覆盖：`ECHO_PDF_CONFIG_JSON`
- 默认 provider env：
  - `OPENAI_API_KEY`
  - `OPENROUTER_KEY`
  - `VERCEL_AI_GATEWAY_KEY`

存储策略（关键）位于 `service.storage`：

- `maxFileBytes`：单文件上限（超过直接拒绝）
- `maxTotalBytes`：总存储上限（写入前自动清理 + 淘汰最老文件）
- `ttlHours`：文件存活时间，超时自动清理
- `cleanupBatchSize`：单次自动淘汰的最大文件数

说明：

- 当前使用 Durable Object 做文件存储，超限不会再返回 SQLite 原生报错，而是返回可读错误：
  - `FILE_TOO_LARGE`
  - `STORAGE_QUOTA_EXCEEDED`

### 部署

```bash
npm install
npm run deploy
```

## 8. CI/CD

- CI：`typecheck + smoke`
- CD：部署前会校验 secrets

GitHub Actions 必需：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
