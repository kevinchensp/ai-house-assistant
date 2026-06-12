# AI House Assistant

内部客服使用的 AI 找房助手 MVP。

## 当前能力

- TypeScript monorepo：`apps/server`、`apps/web`、`packages/shared`
- 后端 API：`POST /api/ai-house-assistant/chat`
- MCP Client：支持 HTTP JSON-RPC `tools/call`
- 需求理解：`LLMProvider.extractRequirement()` 优先，规则解析兜底
- 当前模型：`MockLlmProvider` 本地模拟模型理解能力，后续可替换为国内模型或公司模型网关
- 多轮上下文：同一 session 内支持“周边可以”“预算可以上浮”等短回复继承上一轮需求
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

## 远端 MCP 配置

复制 `.env.example` 为 `.env`，填入内部 MCP Token：

```bash
cp .env.example .env
```

```text
MCP_SERVER_URL=http://8.134.48.145:3100/mcp
MCP_AUTH_TOKEN=replace-with-server-token
PORT=3101
VITE_API_BASE_URL=http://localhost:3101
```

不要把 `.env` 提交到仓库。

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
