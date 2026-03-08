# echo-pdf

`echo-pdf` 是一个运行在 Cloudflare Workers 的 PDF Agent，提供三类能力：

- 提取 PDF 指定页面并转为图片
- OCR 识别页面文本
- 识别表格并输出 LaTeX

支持三种接入方式：MCP、HTTP API、Web UI。

## 服务地址

线上地址：

- MCP: `https://echo-pdf-agent.echofilesai.workers.dev/mcp`
- Web UI: `https://echo-pdf-agent.echofilesai.workers.dev/`
- HTTP API: `https://echo-pdf-agent.echofilesai.workers.dev`

## 快速开始（CLI）

安装：

```bash
npm i -g echo-pdf
```

初始化服务地址：

```bash
echo-pdf init --service-url https://echo-pdf-agent.echofilesai.workers.dev
```

配置 provider key（仅保存在本机）：

```bash
echo-pdf provider set --provider openai --api-key <OPENAI_API_KEY>
echo-pdf provider set --provider openrouter --api-key <OPENROUTER_KEY>
echo-pdf provider set --provider vercel-ai-gateway --api-key <VERCEL_AI_GATEWAY_API_KEY>
```

设置默认 provider / model：

```bash
echo-pdf provider use --provider openrouter
echo-pdf model set --provider openrouter --model openai/gpt-4o-mini
echo-pdf model list
```

查看模型列表（从 API 动态拉取）：

```bash
echo-pdf models --provider openrouter
```

## MCP 使用

连通性检查：

```bash
echo-pdf mcp initialize
echo-pdf mcp tools
echo-pdf mcp call --tool file_ops --args '{"op":"list"}'
```

为不同客户端生成 MCP 配置片段：

```bash
echo-pdf setup add claude-desktop
echo-pdf setup add cursor
echo-pdf setup add cline
echo-pdf setup add windsurf
echo-pdf setup add claude-code
echo-pdf setup add gemini
echo-pdf setup add json
```

## HTTP API 示例

上传 PDF：

```bash
curl -sS -X POST https://echo-pdf-agent.echofilesai.workers.dev/api/files/upload \
  -F 'file=@./sample.pdf'
```

提取页面图片：

```bash
curl -sS -X POST https://echo-pdf-agent.echofilesai.workers.dev/tools/call \
  -H 'content-type: application/json' \
  -d '{"name":"pdf_extract_pages","arguments":{"fileId":"<FILE_ID>","pages":[1],"returnMode":"inline"}}'
```

MCP JSON-RPC（手工调用）：

```bash
curl -sS -X POST https://echo-pdf-agent.echofilesai.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 可用工具

- `pdf_extract_pages`
- `pdf_ocr_pages`
- `pdf_tables_to_latex`
- `file_ops`

## 配置说明

`echo-pdf.config.json` 中的关键项：

- `agent.defaultProvider`
- `agent.defaultModel`
- `service.storage.maxFileBytes`
- `service.storage.maxTotalBytes`
- `service.storage.ttlHours`

常用环境变量：

- `OPENAI_API_KEY`
- `OPENROUTER_KEY` / `OPENROUTER_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY` / `VERCEL_AI_GATEWAY_KEY`
- `ECHO_PDF_DEFAULT_PROVIDER`
- `ECHO_PDF_DEFAULT_MODEL`
- `ECHO_PDF_MCP_KEY`（可选，用于保护 `/mcp`）

---

开发与测试文档见：`docs/DEVELOPMENT.md`
