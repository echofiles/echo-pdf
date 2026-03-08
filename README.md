# echo-pdf (MCP-first PDF Agent)

`echo-pdf` 是一个运行在 Cloudflare Workers 的 PDF Agent。  
主使用方式是 **MCP Server**；Web 页面仅作为线上 Demo。

- MCP endpoint: `https://xx.echofilesai.workers.dev/mcp`
- Demo UI: `https://xx.echofilesai.workers.dev/`
- HTTP tools endpoint: `https://xx.echofilesai.workers.dev/tools/call`

## Why npm CLI

是的，打包成 npm package 更方便发布和部署，原因：

- 统一安装：`npm i -g echo-pdf-agent`
- 统一 provider 配置与模型发现
- 统一输出不同 MCP 客户端的配置片段
- 方便在 CI/CD 或脚本里直接调用

## 1. 安装 CLI

```bash
npm i -g echo-pdf-agent
```

或在仓库内直接运行：

```bash
node ./bin/echo-pdf.js --help
```

## 2. 初始化 CLI（服务地址）

```bash
echo-pdf init --service-url https://xx.echofilesai.workers.dev
```

说明：也支持环境变量 `ECHO_PDF_SERVICE_URL` 作为默认值。

## 3. Provider 配置（本地不落库到服务端）

CLI 会把 key 保存在本机 `~/.config/echo-pdf-cli/config.json`。

### 3.1 设置 key

```bash
echo-pdf provider set --provider openai --api-key <OPENAI_API_KEY>
echo-pdf provider set --provider openrouter --api-key <OPENROUTER_KEY>
echo-pdf provider set --provider vercel-ai-gateway --api-key <VERCEL_AI_GATEWAY_KEY>
```

### 3.2 查看配置状态

```bash
echo-pdf provider list
```

## 4. 从 API 动态获取模型列表（无硬编码）

```bash
echo-pdf models --provider openai
echo-pdf models --provider openrouter
echo-pdf models --provider vercel-ai-gateway
```

## 5. 基础工具调用

### 5.1 查看可用工具

```bash
echo-pdf tools
```

### 5.2 直接调用工具

```bash
echo-pdf call --tool file_ops --args '{"op":"list"}'
```

```bash
echo-pdf call --tool pdf_extract_pages --args '{"fileId":"<FILE_ID>","pages":[1],"returnMode":"inline"}'
```

## 6. MCP 使用（主要方式）

### 6.1 快速检查 MCP 可用性

```bash
echo-pdf mcp initialize
echo-pdf mcp tools
echo-pdf mcp call --tool file_ops --args '{"op":"list"}'
```

### 6.2 手工 JSON-RPC 调用

```bash
curl -sS -X POST https://xx.echofilesai.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

```bash
curl -sS -X POST https://xx.echofilesai.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

```bash
curl -sS -X POST https://xx.echofilesai.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"file_ops","arguments":{"op":"list"}}}'
```

## 7. 给不同工具安装 MCP（CLI 输出配置片段）

```bash
echo-pdf setup add claude-desktop
echo-pdf setup add cursor
echo-pdf setup add cline
echo-pdf setup add windsurf
echo-pdf setup add claude-code
echo-pdf setup add gemini
echo-pdf setup add json
```

说明：

- `claude-desktop/cursor/cline/windsurf`：输出可直接粘贴的 `mcpServers` 配置片段。
- `claude-code/gemini`：若不直接支持 streamable-http，CLI 会提示使用 HTTP->stdio bridge（如 `mcp-remote`）。

## 8. 线上 Demo / HTTP API（次要）

### 上传 PDF

```bash
curl -sS -X POST https://xx.echofilesai.workers.dev/api/files/upload \
  -F 'file=@./sample.pdf'
```

### 流式 trace

```bash
curl -sS -N -X POST https://xx.echofilesai.workers.dev/api/agent/stream \
  -H 'content-type: application/json' \
  -d '{"operation":"extract_pages","fileId":"<FILE_ID>","pages":[1],"returnMode":"inline"}'
```

## 9. 现有工具能力

- `pdf_extract_pages`
- `pdf_ocr_pages`
- `pdf_tables_to_latex`
- `file_ops`

默认规则：工具会继承主 agent 的 provider/model；需要时可请求级覆盖。

## 10. 存储策略（线上必看）

- 单文件限制：`service.storage.maxFileBytes`
- 总量限制：`service.storage.maxTotalBytes`
- 过期清理：`service.storage.ttlHours`
- 批量清理：`service.storage.cleanupBatchSize`

附加接口：

```bash
curl -sS https://xx.echofilesai.workers.dev/api/files/stats
curl -sS -X POST https://xx.echofilesai.workers.dev/api/files/cleanup
```

## 11. 本地开发与验证

```bash
npm install
npm run typecheck
npm run smoke
npm run deploy
```

GitHub Actions secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
