# 部署说明

## 推荐：Docker 单服务部署

这个项目部署后只需要暴露一个端口：后端 API 会同时托管前端静态文件。

### 1. 准备环境变量

不要提交 `.env`。线上至少建议配置：

```bash
MCP_SERVER_URL=http://8.134.48.145:3100/mcp
MCP_AUTH_TOKEN=你的-MCP-token
BAILIAN_API_KEY=你的-百炼-key
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL=qwen-plus
AMAP_WEB_SERVICE_KEY=你的-高德-Web服务-key
AMAP_CITY=广州
PORT=3101
APP_DATA_PATH=/data/ai-house-assistant.json
```

前端高德地图 Key 是构建期变量，需要在 `docker build` 时传入。

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
admin / admin
```

首次上线后建议马上创建客服账号，并尽快把默认管理员密码机制升级掉。

## 非 Docker 部署

```bash
npm ci
npm run build
npm run start --workspace @ai-house-assistant/server
```

如果使用 Nginx，反向代理到 `http://127.0.0.1:3101` 即可。
