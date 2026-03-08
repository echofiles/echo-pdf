# echo-pdf (MCP-first PDF Agent)

`echo-pdf` 是一个部署在 Cloudflare Workers 的 PDF Agent。  
主使用方式是 **MCP Server**；Web UI 只是线上 demo。

- MCP endpoint: `https://xx.echofilesai.workers.dev/mcp`
- Demo UI: `https://xx.echofilesai.workers.dev/`
- HTTP API: `https://xx.echofilesai.workers.dev`

## 1. Node 与运行要求

- Node.js `>=20.0.0`（仓库内有 `.nvmrc`）
- npm、curl、grep、sed

执行前置检查：

```bash
npm run check:runtime
```

## 2. 安装与初始化 CLI

包名已改为 `echo-pdf`。

```bash
npm i -g echo-pdf
```

```bash
echo-pdf init --service-url https://xx.echofilesai.workers.dev
```

CLI 本地配置文件：`~/.config/echo-pdf-cli/config.json`

## 3. LLM 配置：provider + model list + model set

### 3.1 配置 provider key（仅本地）

```bash
echo-pdf provider set --provider openai --api-key <OPENAI_API_KEY>
echo-pdf provider set --provider openrouter --api-key <OPENROUTER_KEY>
echo-pdf provider set --provider vercel-ai-gateway --api-key <VERCEL_AI_GATEWAY_API_KEY>
```

### 3.2 设置默认 provider（用于 call 默认路由）

```bash
echo-pdf provider use --provider openrouter
echo-pdf provider list
```

说明：`provider use` 使用 provider alias（`openai|openrouter|vercel_gateway`）。

### 3.3 动态拉取模型列表（无硬编码）

```bash
echo-pdf models --provider openrouter
```

### 3.4 设置默认 model（新增）

```bash
echo-pdf model set --provider openrouter --model openai/gpt-4o-mini
echo-pdf model get --provider openrouter
echo-pdf model list
```

说明：`echo-pdf call` 不传 `--model` 时，会自动使用该 provider 的默认 model。

## 4. MCP（主要使用方式）

### 4.1 MCP 可用性检查

```bash
echo-pdf mcp initialize
echo-pdf mcp tools
echo-pdf mcp call --tool file_ops --args '{"op":"list"}'
```

### 4.2 手工 JSON-RPC

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

### 4.3 不同客户端安装 MCP

```bash
echo-pdf setup add claude-desktop
echo-pdf setup add cursor
echo-pdf setup add cline
echo-pdf setup add windsurf
echo-pdf setup add claude-code
echo-pdf setup add gemini
echo-pdf setup add json
```

- `claude-desktop/cursor/cline/windsurf`：输出可直接粘贴的 `mcpServers` 片段。
- `claude-code/gemini`：若无 streamable-http 原生支持，使用 HTTP->stdio bridge（如 `mcp-remote`）。

## 5. HTTP / Demo（次要）

```bash
curl -sS -X POST https://xx.echofilesai.workers.dev/api/files/upload \
  -F 'file=@./sample.pdf'
```

```bash
curl -sS -X POST https://xx.echofilesai.workers.dev/tools/call \
  -H 'content-type: application/json' \
  -d '{"name":"pdf_extract_pages","arguments":{"fileId":"<FILE_ID>","pages":[1],"returnMode":"inline"}}'
```

## 6. 测试工程（unit + integration）

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test
npm run smoke
```

`unit` 覆盖：

- `file-utils` 编解码与 returnMode 归一化
- `runFileOp` 文件操作逻辑
- `config` 解析与覆盖

`integration` 覆盖：

- runtime 前置检查（Node>=20 + 命令依赖）
- `health/config/tools` 结构断言
- PDF 上传 + 文件读写 + 删除
- `pdf_extract_pages` 返回 inline 图片 data URL
- `/api/agent/stream` SSE done/result 断言
- MCP `initialize/tools/list/tools/call`
- 存储 stats/cleanup
- 若存在 provider key：真实执行 `/providers/models` + `pdf_ocr_pages`（真实 LLM 链路）

可选参数：

- `SMOKE_BASE_URL=https://xx.echofilesai.workers.dev npm run test:integration`（直接测已部署服务）
- `SMOKE_REQUIRE_LLM=1 npm run test:integration`（强制要求存在 provider key）
- `SMOKE_BASE_URL=https://xx.echofilesai.workers.dev npm run smoke`（快速脚本模式）
- `TESTCASE_DIR=/Users/huangjinfeng/workspace/echofiles/testcase/eda npm run test:integration`（指定测试样例目录）

测试 PDF 选择顺序：

1. `FIXTURE_PDF` 指定文件（smoke）
2. `TESTCASE_DIR` 目录下首个 PDF（默认 `../testcase/eda`）
3. 回退到 `scripts/fixtures/smoke.pdf`

## 7. 部署

```bash
npm run deploy
```

GitHub Actions 必需 secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

可选（用于 CI 真实 LLM 集成测试）：

- `OPENAI_API_KEY`
- `OPENROUTER_KEY`
- `OPENROUTER_API_KEY`（兼容别名）
- `VERCEL_AI_GATEWAY_API_KEY`
- `VERCEL_AI_GATEWAY_KEY`（兼容别名）

## 8. 发布到 npm（协助步骤）

先确认 npm 身份和包名可用：

```bash
npm whoami
npm view echo-pdf version
```

本地打包检查：

```bash
npm pack --dry-run
```

发布：

```bash
npm publish --access public
```

如果 `echo-pdf` 包名已被占用，你有两个选项：

1. 改为 scope 包：`@<your-scope>/echo-pdf`
2. 改为新公共名（例如 `echo-pdf-cli`）
