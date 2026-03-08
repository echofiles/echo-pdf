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

## 1. 服务地址

请先确定你的线上地址（Worker 域名）。文档里用：

- `https://echo-pdf.echofilesai.workers.dev`

你自己的地址如果不同，把下面命令里的域名全部替换掉。

主要端点：

- Web UI: `https://echo-pdf.echofilesai.workers.dev/`
- MCP: `https://echo-pdf.echofilesai.workers.dev/mcp`
- HTTP API 根路径: `https://echo-pdf.echofilesai.workers.dev`

## 2. 快速开始（CLI）

安装：

```bash
npm i -g echo-pdf
```

初始化服务地址：

```bash
echo-pdf init --service-url https://echo-pdf.echofilesai.workers.dev
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

## 3. MCP 使用（推荐）

### 3.1 检查 MCP 服务可用

```bash
echo-pdf mcp initialize
echo-pdf mcp tools
echo-pdf mcp call --tool file_ops --args '{"op":"list"}'
```

### 3.2 给客户端生成 MCP 配置片段

```bash
echo-pdf setup add claude-desktop
echo-pdf setup add cursor
echo-pdf setup add cline
echo-pdf setup add windsurf
echo-pdf setup add json
```

`setup add` 输出的是配置片段，把它合并到对应客户端的 MCP 配置文件。

### 3.3 MCP 工具列表

- `pdf_extract_pages`
- `pdf_ocr_pages`
- `pdf_tables_to_latex`
- `file_ops`

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
- 表格工具返回值会校验并要求包含合法 `tabular`，否则报错。

## 5. HTTP API 使用

### 5.1 上传 PDF

```bash
curl -sS -X POST https://echo-pdf.echofilesai.workers.dev/api/files/upload \
  -F 'file=@./sample.pdf'
```

返回中会拿到 `file.id`。

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
- `service.maxPdfBytes`
- `service.storage.maxFileBytes`
- `service.storage.maxTotalBytes`
- `service.storage.ttlHours`

常用环境变量：

- `OPENAI_API_KEY`
- `OPENROUTER_KEY` / `OPENROUTER_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY` / `VERCEL_AI_GATEWAY_KEY`
- `ECHO_PDF_DEFAULT_PROVIDER`
- `ECHO_PDF_DEFAULT_MODEL`
- `ECHO_PDF_MCP_KEY`（可选，启用 MCP 鉴权）
- `ECHO_PDF_WORKER_NAME`（CLI 默认 URL 推导）

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

