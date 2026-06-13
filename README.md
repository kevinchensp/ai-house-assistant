# AI House Assistant

内部客服使用的 AI 找房助手 MVP。

## 当前能力

- TypeScript monorepo：`apps/server`、`apps/web`、`packages/shared`
- 后端 API：`POST /api/ai-house-assistant/chat`
- MCP Client：支持 HTTP JSON-RPC `tools/call`
- 需求理解：`LLMProvider.extractRequirement()` 优先，规则解析兜底
- 模型接入：支持阿里云百炼 OpenAI-compatible 接口；未配置 API Key 时自动回退 `MockLlmProvider`
- 多轮上下文：同一 session 内支持“周边可以”“预算可以上浮”等短回复继承上一轮需求
- 多客服使用：支持客服姓名登录，每个客服只看到自己的客户会话
- 客户队列：支持同一客服同时跟进多个客户，会话、聊天记录、推荐结果持久化在服务端
- P0 规则：预算解析、位置字典、位置置信度、距离计算、房源排序、schema 校验
- 事件日志：需求发送、需求抽取、位置解析、MCP 调用、推荐展示、话术生成
- 前端工作台：需求输入、推荐房源卡片、客服话术复制、反馈按钮
- 默认 mock MCP：没有 `.env` 时也能本地演示

## 安装

```bash
npm install
```

## 本地启动

启动 API：

```bash
npm run dev --workspace @ai-house-assistant/server
```

启动前端：

```bash
npm run dev --workspace @ai-house-assistant/web -- --port 5173
```

访问：

```text
http://localhost:5173
```

## 远端 MCP 与模型配置

复制 `.env.example` 为 `.env`，填入内部 MCP Token 和模型 API Key：

```bash
cp .env.example .env
```

```text
MCP_SERVER_URL=http://8.134.48.145:3100/mcp
MCP_AUTH_TOKEN=replace-with-server-token
BAILIAN_API_KEY=replace-with-bailian-api-key
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL=qwen-plus
PORT=3101
VITE_API_BASE_URL=http://localhost:3101
```

不要把 `.env` 提交到仓库。

前端顶部状态会读取 `GET /api/health`，显示当前是否为远端 MCP 和真实模型。

## 多客服 MVP 登录

当前版本采用 MVP 级登录：输入客服姓名即可进入个人客户队列。后端会把客户会话按客服账号隔离。

本地持久化文件默认写入：

```text
.data/ai-house-assistant.json
```

`.data/` 已加入 `.gitignore`，不要提交本地客服和客户数据。

## 验证

```bash
npm test
npm run typecheck
npm run build
```

API smoke test：

```bash
curl -sS -X POST http://localhost:3101/api/ai-house-assistant/chat \
  -H 'Content-Type: application/json' \
  --data '{"sessionId":"demo","message":"帮我找白云东平一室一厅，预算1000左右"}'
```

## 文档

- [MVP 方案](docs/superpowers/specs/2026-06-12-ai-house-assistant-mvp-design.md)
- [实施计划](docs/superpowers/plans/2026-06-12-ai-house-assistant-mvp-p0-implementation.md)
- [TODO](docs/TODO.md)
- [项目记忆](docs/MEMORY.md)
