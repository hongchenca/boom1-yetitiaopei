# 客户运维说明 · 0.5.1

首次安装先看 [START-HERE.md](../START-HERE.md)。只部署一套单进程服务；一份数据目录不能被两个实例共用。部署脚本不会自动改系统服务、防火墙或现有 Nginx 配置。

包内有九路称重、八路手动泵控制、配方/人工标定记录和账号角色。自动闭环配液未启用。Docker 模板须由客户在自己的 Linux 服务器验收；开发电脑仅验证了原生 Node 方式。

## 原生 Node：Linux / Windows / 无 Docker

使用 Node.js **24.14.0**（与本次验证版本一致；脚本允许更新的 24.x，但应另行复验）。无第三方依赖、无需 `npm install`。可用独立解压版 Node，通过绝对路径启动，不改变已有业务的全局 Node。

1. 解压到专用应用目录。Windows 可用 `D:\Apps\yetitiaopei`；Linux 示例为 `/opt/yetitiaopei/app`。
2. 复制 `deploy/settings.example.json` 为 `deploy/settings.json`，只改以下配置：

   | 配置 | 默认 | 用法 |
   | --- | --- | --- |
   | APP_HOST | 127.0.0.1 | HTTPS 反向代理部署保留；可信内网直接访问才改 0.0.0.0 |
   | APP_PORT | 18080 | 客户分配的空闲端口 |
   | APP_BASE_PATH | /console | 与反向代理路径一致，不带末尾斜杠 |
   | APP_DATA_DIR | ./data | 推荐独立本地磁盘目录；Windows JSON 用 `D:/YetiData`，Linux 用 `/var/lib/yetitiaopei` |
   | APP_SECURE_COOKIE | true | HTTPS 保留 true；仅可信内网 HTTP 验收时 false |

   相对数据路径以应用目录为基准，不受终端工作目录影响。不要把数据放在公共网站目录或共享网络盘。客户给专用低权限服务账号授予应用目录读取权、数据目录读写权即可；Windows 用目录 ACL，Linux 数据目录建议 700。环境变量优先于 JSON，原来的 APP_* 变量也可能影响结果。

3. 在应用目录运行（Windows PowerShell 和 Linux 相同）：

   ```text
   node deploy/manage.cjs verify
   node deploy/manage.cjs init
   node deploy/manage.cjs start
   ```

   `verify` 检查文件完整性；`init` 检查端口后生成随机登录信息；`start` 可自动完成首次初始化，且不会覆盖已有密码/密钥。服务器本机读取所选数据目录的 `connection.json` 获取首次登录信息，不把文件内容加入日志。

4. 保留启动终端，在另一终端执行 `node deploy/manage.cjs check`。然后添加 HTTPS 代理，浏览器访问 `https://客户域名/console/`。
5. 交付常驻运行前配置进程托管：Linux 可参考 `yetitiaopei.service.example`；宝塔现有 Node 进程管理器入口为 `deploy/manage.cjs`、参数 `start`，**单实例 fork 模式**；Windows 可使用现有服务管理工具或任务计划程序，操作为 Node 绝对路径，参数为 `"D:\Apps\yetitiaopei\deploy\manage.cjs" start`，设置启动触发、无论是否登录都运行、失败重启、禁止并行实例、取消运行时长限制，运行账号仅授权该应用和数据目录。不要重复运行前台服务与托管服务。

Windows 双击 `start-customer.cmd` 可做首次检查/前台运行，**关闭窗口或退出登录会停止，不代替服务托管**。关闭前台后再启用托管。

Linux systemd 示例需要运维先创建专用账号/目录，将 JSON 的数据目录设为 `/var/lib/yetitiaopei`，并核对 Node 路径；然后另存为 `/etc/systemd/system/yetitiaopei.service`，执行 `systemctl daemon-reload`、`systemctl enable --now yetitiaopei`。它只应安装本项目的服务。Node 使用用户家目录安装时，需要调整路径以匹配示例的 ProtectHome 限制。日志由系统 journal 管理。

## 反向代理与网络

`nginx.conf.example` 是合并到现有 HTTPS `server` 的 location 片段，不是全量配置。客户先备份自己的配置，测试后重载。宝塔关闭该路径的缓存、SSE 缓冲和过短超时；不要配置成去掉 `/console` 前缀的 proxy_pass。IIS 或其他代理需实现相同规则：保留路径、转发 Cookie/设备鉴权头、实时流不缓冲、空闲读取超时至少 40 秒。

若 Nginx 也在容器中，容器内的 127.0.0.1 不指向宿主机，应由运维按现有网络接入，不直接照抄宿主机代理地址。HTTPS 证书须被 ESP32 信任；公网入口由客户现有 VPN/访问控制保护，同时允许设备接口通信，不给设备接口套浏览器验证码。不要直接暴露后台监听端口。

本机检查通过后，可在具备 Node 的任意可达机器执行：

```text
node deploy/manage.cjs check https://客户域名/console
```

此检查不会登录、改数据或控制设备。外部健康检查通过后，还需要浏览器登录及设备在线验收。

## Docker 常用命令

以下命令从含 START-HERE.md 的目录执行；自定义端口时使用同一个 `--env-file deploy/.env`。Compose v2 会创建独立的 `yetitiaopei-console_console-data` 数据卷，应用文件只读，数据卷单独持久化。Docker daemon 需启用开机启动。

```sh
# 状态 / 最近日志（密码和 token 不在日志中）
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail 80 console
# 只停止本项目，保留数据卷
docker compose -f deploy/compose.yaml stop
# 启动已有实例
docker compose -f deploy/compose.yaml start
# 在线备份
docker compose -f deploy/compose.yaml exec -T console node deploy/manage.cjs backup
# 将所有备份取出到当前目录的 backup-export
docker compose -f deploy/compose.yaml cp console:/data/backups ./backup-export
```

不要执行 `down -v`、删除数据卷、清理其他服务或把一份数据卷分给多个应用实例。不要同时部署 Docker 与原生方式。

## 备份、更新与回退

原生方式：`node deploy/manage.cjs backup`。备份写到数据目录下 `backups/时间-随机后缀/`；Docker 命令见上。只有包含 `COMPLETE.json` 的目录才是完成且通过 SQLite 检查的备份，含数据库、设备凭据和校验值；对备份目录限制权限并另存到客户备份介质。备份文件中的时间使用 UTC。

更新前停止设备操作、确认泵已停且无待执行指令 → 备份并保留旧程序包/部署配置 → 停服务 → 新版本解压到新应用目录 → 指向原来的数据目录 → 单实例启动并检查。Docker 使用相同项目名/卷名保留数据，保存旧版本镜像后，停旧容器、在新包执行 build/up。不直接覆盖运行中的程序，不删除旧数据。

回退先停新服务。原生方式新建空数据目录，将所选完整备份中的 `telemetry-v1.db` 与 `connection.json` 放入，再用旧包配置指向这个新目录启动。Docker 先保留原数据卷，把备份恢复到新数据卷（目标目录归 node 的 UID/GID 1000 所有），用旧版本镜像和改为新卷名的 Compose 配置启动。不要混用旧 WAL/SHM，也不要让新旧容器同时访问一份数据。客户运维先在测试目录演练恢复后再接受正式备份。

数据库中的账号密码以数据库为准；首次 connection.json 的管理员密码在网页修改密码后不会同步更新。重启前未确认命令会变成 unknown，不自动重放；恢复旧库可能使控制序号落后，维护方确认设备安全停机后再重启设备建立新 boot，并重新验收。称重校准参数保存在设备 NVS，不在网页数据库备份中。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| EADDRINUSE / port is already allocated | 为本应用另分配端口并同步代理；不终止未知进程 |
| SQLite ExperimentalWarning | Node 24 的提示；以“服务正常”及退出码判断，不是启动失败 |
| JSON 格式错误 | 使用 UTF-8、双引号，Windows 路径用正斜杠，不加末尾逗号 |
| HTTP 下登录反复失效 | 默认启用 Secure Cookie，使用 HTTPS；可信内网临时测试才关闭 |
| 502 / 404 | 检查进程、端口、代理保留 /console、先本机 check 再外网 check |
| 页面时断时续 | 先查代理 SSE 缓冲/超时，再查设备 Wi-Fi 和服务器网络 |
| 页面正常但设备离线 | 固件中的地址、设备 ID、token 要与客户服务匹配；检查 HTTPS/授时/路由 |
| Docker 镜像下载失败 | 让运维使用已有镜像源；离线环境按客户 CPU 提前制作并导入应用镜像 |

开发端封包：工程根目录 `py -3 scripts/package_customer.py`，仅白名单文件入包，产出 ZIP、SHA-256 和清单。不交付 data/、artifacts/、配置密钥、已配置固件或其他项目文件。文件哈希用于检查完整性，不代替可信传输渠道。
