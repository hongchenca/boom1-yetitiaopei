# 客户自行部署说明（联调版）

当前包为 0.2.0 网络联调版，不具备真实泵控制、称重、自动配液或生产多角色管理。无需向开发方提供服务器账号；客户运维执行以下操作。不会自动修改全局服务、防火墙、反向代理或其他业务资料。

## 交付目录

交付 web_server 中的 *.js、package.json、public/、deploy/ 和 README.md；测试可选。**排除 data/、artifacts/、config.local.json、device.local.json、所有真实凭据及私有固件头/已配置固件镜像**。不要复制开发电脑的数据库/登录密码。Node 无第三方依赖；仅需客户提供已验证的 Node 24.14.x。

由客户创建专用非特权服务账号、只读应用目录和独立可写的本地数据目录。只授权这两个目录，不授权客户其他业务路径。服务保持单进程，无 cluster/多 worker。

## 配置示例（Linux shell）

以下路径/端口由客户分配，不自动创建系统目录：

```sh
export APP_HOST=127.0.0.1
export APP_PORT=8000
export APP_BASE_PATH=/console
export APP_DATA_DIR=/path/assigned/to/yetitiaopei-data
export APP_SIMULATOR=0
export APP_SECURE_COOKIE=1
node /path/assigned/to/yetitiaopei-app/server.js
```

Windows 用 PowerShell `$env:APP_PORT='8000'` 等同样设置。首次启动后凭据仅写入 APP_DATA_DIR/connection.json；限制此目录 ACL，不通过日志泄露。env.example 只是变量列表，应用不会自动读取 .env 文件。

HTTPS 在客户现有反向代理终止，由客户安装证书。nginx.conf.example 是可合并的 **location 片段**，不是替换客户 nginx.conf 的脚本；示例保留 /console 前缀。SSE 禁止缓存/缓冲；长轮询代理超时要大于 25 秒。不信任客户端自行设置的代理身份头。

## 最小验收

1. 本机直接请求 /console/api/v1/healthz 返回 ok；外部经 HTTPS 请求也成功。
2. 从 /console 重定向到 /console/，登录、CSS/JS、SSE 正常；模拟器关闭，真实设备无上报显示离线。
3. 使用客户新设备 token 配置 ESP；验证设备所在网络能访问服务及授时源，证书被设备信任。
4. 上传后只操作 ping/上报周期，核对回执和后续遥测实际值；不连接泵。
5. 在线备份到新文件并进行停服/新目录恢复演练；重启前待确认命令不重放。
6. 验证升级/回滚：保存旧应用目录及一致性备份，新版本先在另一端口和新数据副本演练；无数据库 schema 迁移时也必须验证兼容，不能直接覆盖客户数据。

正式封包前还需客户确认 OS/CPU、Node 安装方式、端口/域名/子路径、代理/证书、专用数据目录、内网路由和离线安装要求。本轮未在客户服务器执行任何部署。
