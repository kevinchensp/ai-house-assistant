# GitHub 自动部署

推送到 GitHub 的 `main` 分支后，GitHub Actions 会自动上传代码到服务器，并重新构建 Docker 容器。

## 1. 先准备服务器 SSH 账号

自动部署必须能通过 SSH 登录服务器。需要确认下面命令能在你电脑上登录成功：

```bash
ssh 用户名@8.134.48.145
```

如果你没有可用的 SSH 账号，需要在云服务器控制台重置 root 密码，或者创建一个有 Docker 权限的部署账号。

## 2. 推送代码到 GitHub

把本项目上传到 GitHub 仓库，并确保默认分支是：

```text
main
```

## 3. 配置 GitHub Secrets

进入 GitHub 仓库：

```text
Settings > Secrets and variables > Actions > New repository secret
```

新增这些：

```text
DEPLOY_HOST=8.134.48.145
DEPLOY_PORT=22
DEPLOY_USER=你的SSH用户名
DEPLOY_PASSWORD=你的SSH密码
```

## 4. 触发部署

之后每次推送：

```bash
git push
```

GitHub 会自动部署。

也可以手动触发：

```text
GitHub 仓库 > Actions > Deploy > Run workflow
```

## 注意

- 自动部署会保留服务器上的 `.env` 文件。
- 自动部署会先清理旧 release 文件再解压新代码，避免过期文件残留影响构建。
- 自动部署会重建 `ai-house-assistant-app:latest` 镜像。
- 业务数据在 Docker volume `app-data` 中，不会因为重建镜像丢失。
