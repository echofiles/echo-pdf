# echo-pdf

`echo-pdf` 是一个部署在 Cloudflare Workers 的 PDF Agent，支持：

- 页面提取：把 PDF 指定页渲染为图片
- OCR：识别页面文本
- 表格识别：提取表格并输出 LaTeX `tabular`
- MCP 服务：可直接挂到 Claude Desktop / Cursor / Cline / Windsurf 等客户端

支持三种使用方式：

- MCP（推荐）
- CLI
- HTTP API

## Use echo-pdf as a component

推荐把 `echo-pdf` 作为一个独立组件服务接入（MCP-first，HTTP fallback），下游系统（如 echo-datasheet）只通过 URL 调用，不直接依赖实现代码。

### Downstream config

下游至少配置以下变量：

```bash
export ECHO_PDF_BASE_URL="http://127.0.0.1:8787"
export ECHO_PDF_MCP_URL="${ECHO_PDF_BASE_URL}/mcp"
# optional
export ECHO_PDF_MCP_KEY="<your-mcp-key>"
```

### Local-first quick start

```bash
npm i -g @echofiles/echo-pdf
echo-pdf dev --port 8787
```

`echo-pdf dev` 启动时会打印可直接给下游使用的：

- `ECHO_PDF_BASE_URL`
- `ECHO_PDF_MCP_URL`

健康检查与能力检查：

```bash
curl -sS "$ECHO_PDF_BASE_URL/health"
curl -sS "$ECHO_PDF_BASE_URL/tools/catalog"
```

### Recommended call flow (downstream)

1. 下游先做 ingest（例如 `echo_pdf_ingest`），上传 PDF 到 `POST /api/files/upload`，得到 `echoPdfFileId`。  
2. 下游通过 MCP/HTTP 调工具，并传 `fileId=echoPdfFileId`：
  - `pdf_extract_pages`
  - `pdf_ocr_pages`
  - `pdf_tables_to_latex`

MCP-first 示例：

```bash
curl -sS -X POST "$ECHO_PDF_MCP_URL" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pdf_extract_pages","arguments":{"fileId":"<FILE_ID>","pages":[1]}}}'
```

HTTP fallback 示例：

```bash
curl -sS -X POST "$ECHO_PDF_BASE_URL/tools/call" \
  -H 'content-type: application/json' \
  -d '{"name":"pdf_extract_pages","arguments":{"fileId":"<FILE_ID>","pages":[1]}}'
```

## Using echo-pdf as a library

`@echofiles/echo-pdf` 支持直接作为库导入，面向下游复用 `pdf_extract_pages / pdf_ocr_pages / pdf_tables_to_latex / file_ops` 工具实现。

### Public entrypoints（semver 稳定）

- `@echofiles/echo-pdf`：core API（推荐）
- `@echofiles/echo-pdf/core`：与根入口等价的 core API
- `@echofiles/echo-pdf/worker`：Worker 路由入口（给 Wrangler/Worker 集成用）

仅以上 `exports` 子路径视为公开 API。`src/*`、`dist/*` 等深路径导入不受兼容性承诺保护，可能在次版本中变动。

### Runtime expectations

- Node.js: `>=20`（与 `package.json#engines` 一致）
- 需要 ESM `import` 能力与标准 `fetch`（Node 20+ 原生支持）
- 建议使用支持 package `exports` 的现代 bundler/runtime（Vite、Webpack 5、Rspack、esbuild、Wrangler 等）
- TypeScript 消费方建议：`module=NodeNext` + `moduleResolution=NodeNext`

### Clean project import smoke

下面这段命令与仓库中的集成测试保持一致，可在全新目录验证 npm 包“可直接 import”：

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm i /path/to/echofiles-echo-pdf-<version>.tgz
node --input-type=module -e "await import('@echofiles/echo-pdf'); await import('@echofiles/echo-pdf/core'); await import('@echofiles/echo-pdf/worker'); console.log('ok')"
```

### Example

```ts
import { callTool, listToolSchemas } from "@echofiles/echo-pdf"
import configJson from "./echo-pdf.config.json" with { type: "json" }

const fileStore = {
  async put(input) {
    const id = crypto.randomUUID()
    const record = { ...input, id, sizeBytes: input.bytes.byteLength, createdAt: new Date().toISOString() }
    memory.set(id, record)
    return record
  },
  async get(id) {
    return memory.get(id) ?? null
  },
  async list() {
    return [...memory.values()]
  },
  async delete(id) {
    return memory.delete(id)
  },
}

const memory = new Map()
const env = {}

console.log(listToolSchemas().map((tool) => tool.name))

const result = await callTool(
  "pdf_extract_pages",
  { fileId: "<FILE_ID>", pages: [1], returnMode: "inline" },
  { config: configJson, env, fileStore }
)
console.log(result)
```

版本策略：

- `exports` 列出的入口及其导出符号按 semver 管理
- 对公开 API 的破坏性变更只会在 major 版本发布
- 新增导出、参数扩展（向后兼容）会在 minor/patch 发布

## 1. 服务地址

请先确定你的线上地址（Worker 域名）。文档里用：

- `https://echo-pdf.echofilesai.workers.dev`

你自己的地址如果不同，把下面命令里的域名全部替换掉。

主要端点：

- Web UI: `https://echo-pdf.echofilesai.workers.dev/`
- MCP: `https://echo-pdf.echofilesai.workers.dev/mcp`
- HTTP API 根路径: `https://echo-pdf.echofilesai.workers.dev`

## 1.1 API 兼容性说明

- 从 `v0.3.0` 开始，`POST /tools/call` 返回结构改为：
  - `{"ok": true, "data": ..., "artifacts": [...]}`
- 老格式 `{"name":"...","output":...}` 已移除。
- MCP `tools/call` 仍保留 `type:"text"`，并新增 `type:"resource_link"` 供下载二进制结果。

## 2. 快速开始（CLI）

安装：

```bash
npm i -g @echofiles/echo-pdf
```

初始化服务地址：

```bash
echo-pdf init --service-url https://echo-pdf.echofilesai.workers.dev
```

本地一键启动服务（daemon）：

```bash
echo-pdf dev --port 8788
echo-pdf init --service-url http://127.0.0.1:8788
```

配置 API Key（仅保存在本机 CLI 配置，不会上报到服务端存储）：

```bash
echo-pdf provider set --provider openai --api-key <OPENAI_API_KEY>
echo-pdf provider set --provider openrouter --api-key <OPENROUTER_KEY>
echo-pdf provider set --provider vercel-ai-gateway --api-key <VERCEL_AI_GATEWAY_API_KEY>
```

设置默认 provider + model（项目采用单一默认，不做多层 fallback）：

```bash
echo-pdf provider use --provider vercel_gateway
echo-pdf model set --provider vercel_gateway --model google/gemini-3-flash
echo-pdf model list
```

拉取 provider 模型列表（实时从 provider API 获取，无 hardcode）：

```bash
echo-pdf models --provider vercel_gateway
```

修改运行时配置（写入 `.dev.vars` 的 `ECHO_PDF_CONFIG_JSON`）：

```bash
echo-pdf config set --key service.maxPdfBytes --value 10000000
echo-pdf config set --key service.storage.maxFileBytes --value 10000000
echo-pdf config set --key service.maxPagesPerRequest --value 20
```

## 3. MCP 使用（推荐）

### 3.1 检查 MCP 服务可用

```bash
echo-pdf mcp initialize
echo-pdf mcp tools
echo-pdf mcp call --tool file_ops --args '{"op":"list"}'
```

### 3.1.1 纯 MCP 场景推荐流程（本地 PDF）

远端 MCP server 无法直接读取你本机文件路径。推荐两步：

1. 先通过 HTTP 上传本地 PDF，拿到 `fileId`
2. 再用 MCP 工具传 `fileId` 调用

示例：

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/api/files/upload \
  -F 'file=@./input.pdf'

echo-pdf mcp call --tool pdf_extract_pages --args '{"fileId":"<FILE_ID>","pages":[1]}'
```

### 3.1.2 不上传文件的 URL ingest 流程

如果 PDF 已经在公网可访问，直接传 `url`：

```bash
echo-pdf mcp call --tool pdf_extract_pages --args '{
  "url":"https://example.com/sample.pdf",
  "pages":[1]
}'
```

### 3.1.3 stdio MCP（支持本地文件路径）

stdio 模式会把本地 `path/filePath` 自动上传为 `fileId` 后再调用远端工具。

```bash
echo-pdf mcp-stdio
```

生成 Claude Desktop/Cursor 等可用的 stdio 配置片段：

```bash
echo-pdf setup add claude-desktop --mode stdio
```

### 3.2 给客户端生成 MCP 配置片段

```bash
echo-pdf setup add claude-desktop
echo-pdf setup add cursor
echo-pdf setup add cline
echo-pdf setup add windsurf
echo-pdf setup add json
echo-pdf setup add claude-desktop --mode stdio
```

`setup add` 输出的是配置片段，把它合并到对应客户端的 MCP 配置文件。

### 3.3 MCP 工具列表

- `pdf_extract_pages`
- `pdf_ocr_pages`
- `pdf_tables_to_latex`
- `file_ops`

MCP 输出策略：

- `pdf_extract_pages` 在 MCP 下默认 `returnMode=url`（不传 `returnMode` 时生效）
- MCP `text` 会对大字段做去二进制/截断，避免把大段 base64 塞进上下文
- 二进制结果请优先使用 `resource_link` 中的下载地址

## 4. Web UI 使用

打开：

- `https://echo-pdf.echofilesai.workers.dev/`

流程：

1. 选择 provider。
2. 点击“测试模型列表”后，选择一个模型。
3. 上传 PDF。
4. 选择工具并填写参数（例如 `pages: [1]`）。
5. 点击 `Run Tool` 或 `Run Stream`。

说明：

- UI 中输入的 key 属于当前会话，不落库到服务端。
- `returnMode` 支持 `inline`、`file_id`、`url`。
- `tools/call` 返回统一结构：`{ ok, data, artifacts }`，其中 `artifacts[*].url` 可直接下载。
- 表格工具返回值会校验并要求包含合法 `tabular`，否则报错。

## 5. HTTP API 使用

### 5.1 上传 PDF

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/api/files/upload \
  -F 'file=@./sample.pdf'
```

返回中会拿到 `file.id`。

CLI 等价命令：

```bash
echo-pdf file upload ./sample.pdf
```

### 5.2 提取页面图片

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/tools/call \
  -H 'content-type: application/json' \
  -d '{
    "name":"pdf_extract_pages",
    "arguments":{"fileId":"<FILE_ID>","pages":[1],"returnMode":"inline"},
    "provider":"vercel_gateway",
    "model":"google/gemini-3-flash"
  }'
```

CLI（默认不自动上传本地文件，需显式开启）：

```bash
echo-pdf call --tool pdf_extract_pages --auto-upload --args '{"path":"./sample.pdf","pages":[1],"returnMode":"url"}'
```

说明：

- `echo-pdf call` 默认禁用本地文件自动上传，避免误上传脚枪。
- 需要自动上传时，显式传 `--auto-upload`，CLI 会回显上传清单（本地路径 -> fileId）。
- 如果是本地 agent/IDE 场景，优先使用 `echo-pdf mcp-stdio`，它会按 MCP stdio 约定处理 `path/filePath` 自动上传。

下载产物：

```bash
echo-pdf file get --file-id <FILE_ID> --out ./output.bin
```

### 5.3 OCR

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/tools/call \
  -H 'content-type: application/json' \
  -d '{
    "name":"pdf_ocr_pages",
    "arguments":{"fileId":"<FILE_ID>","pages":[1],"provider":"vercel_gateway","model":"google/gemini-3-flash"}
  }'
```

### 5.4 表格识别为 LaTeX

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/tools/call \
  -H 'content-type: application/json' \
  -d '{
    "name":"pdf_tables_to_latex",
    "arguments":{"fileId":"<FILE_ID>","pages":[1],"provider":"vercel_gateway","model":"google/gemini-3-flash"}
  }'
```

## 6. 配置与环境变量

统一配置文件：`echo-pdf.config.json`

关键字段：

- `agent.defaultProvider`
- `agent.defaultModel`
- `service.publicBaseUrl`
- `service.fileGet.cacheTtlSeconds`
- `service.maxPdfBytes`
- `service.storage.maxFileBytes`
- `service.storage.maxTotalBytes`
- `service.storage.ttlHours`

限制关系说明：

- `service.maxPdfBytes`：允许处理的 PDF 最大字节数。
- `service.storage.maxFileBytes`：文件存储单文件上限（上传 PDF、`url/base64` ingest、以及 `file_id` 结果都会落到存储层）。
- 当前项目要求 `service.storage.maxFileBytes >= service.maxPdfBytes`，否则配置无效并在启动时报错。
- 当前默认配置下两者都是 `10000000`（10MB）。
- 当未绑定 R2、使用 DO 存储时，`service.storage.maxFileBytes` 必须 `<= 1200000`，否则启动会报错。
- 生产建议始终绑定 R2，并让 DO 只负责协调/元数据，不承载大文件数据。

常用环境变量：

- `OPENAI_API_KEY`
- `OPENROUTER_KEY` / `OPENROUTER_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY` / `VERCEL_AI_GATEWAY_KEY`
- `ECHO_PDF_DEFAULT_PROVIDER`
- `ECHO_PDF_DEFAULT_MODEL`
- `ECHO_PDF_PUBLIC_BASE_URL`（可选，强制 artifacts 生成外部可访问绝对 URL）
- `ECHO_PDF_FILE_GET_CACHE_TTL_SECONDS`（可选，`/api/files/get` 缓存秒数，`0` 表示 `no-store`）
- `ECHO_PDF_FILE_GET_AUTH_HEADER` + `ECHO_PDF_FILE_GET_AUTH_ENV`（可选，启用下载端点 header 鉴权）
- `ECHO_PDF_MCP_KEY`（可选，启用 MCP 鉴权）
- `ECHO_PDF_WORKER_NAME`（CLI 默认 URL 推导）

鉴权注意：

- 如果配置了 `authHeader/authEnv` 但未注入对应 secret，服务会返回配置错误（fail-closed），不会默认放行。
- 仅开发调试场景可显式设置 `ECHO_PDF_ALLOW_MISSING_AUTH_SECRET=1` 临时放行“缺 secret”的请求。

## 7. 本地开发与测试

安装与开发：

```bash
npm install
npm run dev
```

测试：

```bash
npm run typecheck
npm run test
npm run smoke
```

导出真实调用结果到 `fixtures/output`（会先清空输出目录）：

```bash
INPUT_PDF=./fixtures/input.pdf ./scripts/export-fixtures.sh
```

## 8. 常见问题

### 8.1 设置了模型但没生效

请确认三处一致：

- CLI 当前 profile 的 `model set` 值
- 请求里传入的 `model`
- 实际 provider 的模型列表中存在该 model

当前项目策略是“用户设置的 provider/model 即默认”，不会自动切换到其它模型。

### 8.2 `pdf_tables_to_latex` 返回失败

当前实现要求模型输出中必须包含合法 `\\begin{tabular}...\\end{tabular}`。如果模型返回解释性文本或超时，会直接报错。

### 8.3 `returnMode=url` 如何使用

`url` 模式会把结果落到存储层，并返回一个可直接 `GET` 的下载地址：

- `GET /api/files/get?fileId=<id>`

示例（提取页面并返回 URL）：

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/tools/call \
  -H 'content-type: application/json' \
  -d '{
    "name":"pdf_extract_pages",
    "arguments":{"fileId":"<FILE_ID>","pages":[1],"returnMode":"url"}
  }'
```

### 8.4 错误码语义

- 客户端输入错误返回稳定 `4xx + code`，例如：
  - `PAGES_REQUIRED`（400）
  - `PAGE_OUT_OF_RANGE`（400）
  - `MISSING_FILE_INPUT`（400）
  - `FILE_NOT_FOUND`（404）
- 服务端故障返回 `5xx`。
