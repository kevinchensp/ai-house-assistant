# AI House Assistant

内部客服使用的 AI 找房助手 MVP。

## 当前能力

- TypeScript monorepo：`apps/server`、`apps/web`、`packages/shared`
- 后端 API：`POST /api/ai-house-assistant/chat`
- MCP Client：支持 HTTP JSON-RPC `tools/call`
- 地理检索：支持 MCP `search_houses_geo`，按坐标半径查询附近房源
- 位置解析：支持高德地图位置解析；前端 Web JS 可解析客户输入位置，后端可选接入高德 Web 服务 Key
- 房源图片：支持读取 `get_house_detail.images` 并在推荐卡片展示首图，无图时显示占位
- 需求理解：`LLMProvider.extractRequirement()` 优先，规则解析兜底
- 模型接入：支持阿里云百炼 OpenAI-compatible 接口；未配置 API Key 时自动回退 `MockLlmProvider`
- 多轮上下文：同一 session 内支持“周边可以”“预算可以上浮”等短回复继承上一轮需求
- 多客服使用：支持手机号+密码登录，每个客服只看到自己的客户会话
- 账号开通：默认管理员账号 `admin`，管理员可在独立页面开通客服账号
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
VITE_AMAP_WEB_MAP_KEY=replace-with-amap-web-js-key
VITE_AMAP_SECURITY_JS_CODE=replace-with-amap-security-js-code
AMAP_WEB_SERVICE_KEY=replace-with-amap-web-service-key
AMAP_CITY=广州
```

不要把 `.env` 提交到仓库。

高德配置说明：

- `VITE_AMAP_WEB_MAP_KEY` 是前端高德 JS 地图 Key，用于需求位置地图和浏览器端 POI 解析。
- `VITE_AMAP_SECURITY_JS_CODE` 是前端高德 JS 安全密钥，会在加载地图脚本前写入 `window._AMapSecurityConfig`。
- `AMAP_WEB_SERVICE_KEY` 是后端高德 Web 服务 Key，用于服务端 POI 解析；如果未配置，后端会依赖前端传入的解析结果和本地兜底规则。
- 当前 MVP 前端地图展示和 POI 解析使用同一组 JS 配置，并通过 `https://pass-api.ibtmap.com/a/webapi/maps` 加载；不要把前端 JS Key 当作后端 REST Key 使用。

前端顶部状态会读取 `GET /api/health`，显示当前是否为远端 MCP 和真实模型。

## 多客服 MVP 登录

当前版本采用 MVP 级登录：客服使用手机号和密码登录，后端会把客户会话按客服账号隔离。

默认管理员账号：

```text
账号：admin
密码：admin
```

管理员登录后进入“账号开通”页面，可创建客服账号。MVP 暂不做用户组和组织架构，只保证多个客服同时使用时数据按个人隔离。

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
