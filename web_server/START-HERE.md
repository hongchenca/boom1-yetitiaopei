# 客户部署：先看这份

版本 0.5.1。网页、后台、称重显示及手动设备操作在同一个服务中。无需 npm install 或前端编译。

由客户运维在独立目录部署；客户无需提供服务器账号给开发方。首次部署生成客户自己的登录密码和设备密钥，包内没有开发环境的数据或密码。

## Linux / 宝塔：优先使用现有 Docker

前提：服务器已有 Docker Engine 和 Compose v2，并能下载 `node:24.14.0-bookworm-slim`。没有 Docker 时看 [原生 Node 部署](deploy/README.md)，不要为本项目随意升级现有业务的运行环境。

1. 将压缩包解压到专用目录，进入含本文件的 `yetitiaopei` 目录。
2. 执行：

   ```sh
   docker compose -f deploy/compose.yaml up -d --build --wait --wait-timeout 120
   docker compose -f deploy/compose.yaml exec -T console node deploy/manage.cjs check
   ```

   出现“服务正常：0.5.1”说明后台已启动。应用仅占用 `127.0.0.1:18080`，日志自动轮转；容器在退出后自动重启。Docker 服务自身须随系统启动。

3. 在客户现有 **HTTPS 站点**中添加 [Nginx location 片段](deploy/nginx.conf.example)，先 `nginx -t`，通过后再重载。最终访问 `https://客户域名/console/`。保持 `/console` 路径，不启用 SSE 缓冲/缓存。
4. 运维在服务器本机查看首次登录信息：

   ```sh
   docker compose -f deploy/compose.yaml exec console cat /data/connection.json
   ```

   用其中 `username`、`password` 登录，随后在网页修改密码；此文件中的 `token` 是设备密钥，不要截图或发群聊。

**端口被占用：**在 `deploy/.env` 新建一行 `YETI_PORT=18081`，后续所有 Compose 命令增加 `--env-file deploy/.env`（放在 `-f` 前），并把 Nginx 片段的 `18080` 改为 `18081`。不要结束未知服务。`deploy/settings.json` 只控制原生 Node，Docker 使用 Compose 环境变量。

## 最后一步：让设备接上新服务

网页部署成功不等于设备已迁移。把客户确定的 HTTPS 地址（如 `https://客户域名/console`，末尾不带 `/`）及设备 ID/设备 token，通过双方约定的保密渠道交给设备维护方。不要发送管理员登录密码。

当前 ESP32 的服务器地址、Wi-Fi 和 token 在固件配置中，不能在网页里直接改服务器；需要维护方配置、构建并更新设备固件。设备所在网络必须能访问该地址和授时源。内网自签证书/离线授时需要单独适配。

验收：HTTPS 登录正常 → 九路页面正常显示 → 对应实机显示在线且序号持续增加 → 查看重量更新、刷新重连和业务记录。开泵与校准由现场人员另行验收，部署不自动触发设备动作。

## 交给开发方的信息

- 服务器系统/CPU、是否已有 Docker（或 Node.js 24.14.0）；能否联网下载运行环境。
- 分配的 HTTPS 访问地址、空闲端口、由谁添加反向代理。
- 设备所在网络是否能访问服务器。

出错时只提供报错信息和不含凭据的日志。备份、更新、回退、Windows / 无 Docker 安装方法见 [运维说明](deploy/README.md)。
