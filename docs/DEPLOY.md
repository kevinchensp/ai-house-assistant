# 部署说明

## 推荐：Docker 单服务部署

这个项目部署后只需要暴露一个端口：后端 API 会同时托管前端静态文件。

### 1. 准备环境变量

不要提交 `.env`。线上至少建议配置：

```bash
MCP_SERVER_URL=http://8.134.48.145:3100/mcp
MCP_AUTH_TOKEN=你的-MCP-token
ADMIN_INITIAL_PASSWORD=首次管理员密码
BAILIAN_API_KEY=你的-百炼-key
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL=qwen-plus
AMAP_WEB_SERVICE_KEY=你的-高德-Web服务-key
AMAP_CITY=广州
PORT=3101
APP_DATA_PATH=/data/ai-house-assistant.json
CORS_ORIGIN=
AUTH_TOKEN_TTL_MS=28800000
MCP_TIMEOUT_MS=12000
BAILIAN_TIMEOUT_MS=15000
AMAP_TIMEOUT_MS=5000
```

前端高德地图 Key 是构建期变量，需要在 `docker build` 时传入。

`ADMIN_INITIAL_PASSWORD` 只在首次创建 `admin` 管理员时使用；已有数据后可以移除。新环境不配置该值时，服务会拒绝自动创建默认弱口令管理员。

同源 Docker 部署时 `CORS_ORIGIN` 可以留空；如果前端和 API 分开部署，需要填允许访问 API 的前端域名，多个源用逗号分隔。

### 2. 构建镜像

同源部署时 `VITE_API_BASE_URL` 留空即可：

```bash
docker build -t ai-house-assistant:latest \
  --build-arg VITE_API_BASE_URL= \
  --build-arg VITE_AMAP_WEB_MAP_KEY=你的-高德-JS-key \
  --build-arg VITE_AMAP_SECURITY_JS_CODE=你的-高德-security-js-code \
  .
```

### 3. 启动容器

```bash
docker run -d --name ai-house-assistant \
  --restart unless-stopped \
  -p 3101:3101 \
  --env-file .env \
  -v ai-house-assistant-data:/data \
  ai-house-assistant:latest
```

访问：

```text
http://你的服务器IP:3101
```

### 4. 验证

```bash
curl http://你的服务器IP:3101/api/health
```

默认管理员账号：

```text
账号：admin
密码：取自首次启动时的 ADMIN_INITIAL_PASSWORD
```

首次上线后建议马上创建客服账号，并移除服务器 `.env` 中的 `ADMIN_INITIAL_PASSWORD`。

## 非 Docker 部署

```bash
npm ci
npm run build
npm run start --workspace @ai-house-assistant/server
```

如果使用 Nginx，反向代理到 `http://127.0.0.1:3101` 即可。
