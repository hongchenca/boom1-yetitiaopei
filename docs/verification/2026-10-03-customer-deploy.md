# 客户自行部署包验证 · 2026-10-03

交付包：`dist/yetitiaopei-0.5.1-client-20261003T120446Z.zip`（北京时间 2026-10-03 20:04:46 封包）。

SHA-256：`34c9f93998488f20bbfe9230a0f6a72005d0ea64a1bcc9ab14e5eeca250629b2`。

26 个文件，由 `scripts/package_customer.py` 白名单打包；包含 25 个应用/部署文件及一份 release-manifest.json。清单记录源码提交、工作区有未提交修改、文件哈希与已验证的 Node 版本。没有打包本机数据库、凭据、日志、固件或客户资料。应用包不含 Node / Docker 运行环境。

## 已执行

- [PASS] Windows / Node 24.14.0，将实际 ZIP 解压到 `web_server/artifacts/customer-package-20261003/yetitiaopei` 后测试；测试另建临时应用与数据目录、独立随机端口，不使用正在运行的设备服务。
- [PASS] 清单校验、独立数据路径、重复初始化保留身份、应用文件变更后拒绝启动。
- [PASS] 端口占用/错误配置在创建客户数据前失败，不停止其他服务。
- [PASS] /console 子路径、全部页面资源、Secure 登录 Cookie、账号鉴权、SSE。
- [PASS] 在线一致性备份、备份哈希/SQLite quick_check、新目录恢复后登录及配方内容验证。
- [PASS] 运行日志不包含测试密码或设备 token。
- [PASS] 3 项交付包测试、17 项原有 API/业务/滤波测试；git diff --check 通过。

复验命令（PowerShell，工程根目录）：

```powershell
$env:YETI_RELEASE_DIR=(Resolve-Path web_server/artifacts/customer-package-20261003/yetitiaopei).Path
node --test --test-isolation=none web_server/tests/deploy.test.js
node --test --test-isolation=none web_server/tests/api.test.js web_server/tests/business.test.js web_server/tests/weight-filter.test.js
Get-FileHash dist/yetitiaopei-0.5.1-client-20261003T120446Z.zip -Algorithm SHA256
```

## 尚未执行

- [NOT RUN] 本机没有 Docker，未构建/运行容器，也未验证 Linux systemd 或 Windows 计划任务常驻运行。
- [NOT RUN] 客户服务器部署、现有代理合并、外部 HTTPS 证书/网络及重启验收。
- [HW REQUIRED] ESP32 切换客户服务器地址/密钥、客户现场网络授时和真实设备操作验收。没有刷写、复位或操作泵。

建议客户优先复用已有 Docker 或 Node 环境，按照 START-HERE.md 选择一种方式部署。数据目录/卷只能供一个实例使用；部署前由客户分配端口及 HTTPS 路径。服务包使用新的随机身份，不继承开发环境数据。客户若需现有业务记录迁移，应另行安排一致性备份和身份迁移，不能直接拷贝运行中的 SQLite 文件。

## 客户确认 Linux 后的专用包

北京时间 2026-10-03 20:30:37 生成 `dist/yetitiaopei-0.5.1-linux-20261003T123037Z.tar.gz`，SHA-256 为 `9517215fc6162e46b1bf5e74e9f41dd7e9556d06853a040ba2ff0e08f568a1ae`。命令：`py -3 scripts/package_customer.py --platform linux`。

25 个文件，移除 Windows 启动器，以 LINUX-DEPLOY.md 内容作为包内 START-HERE.md，统一 LF 换行和 0644 文件权限。无运行时代码变更。

- [PASS] 解压实际 tar.gz 到 `web_server/artifacts/linux-package-20261003`，设置 YETI_RELEASE_DIR 指向其 yetitiaopei 子目录，重新执行 3 项交付测试，全部通过；包哈希匹配伴随的 .sha256 文件。
- [NOT RUN] 上述复验仍在 Windows / Node 24.14.0，Linux/Docker/systemd 及客户 HTTPS/设备网络现场验收要求不变。

## AlmaLinux 9.7 / x86_64 专用包（最新）

根据客户提供的 `AlmaLinux 9.7 (Moss Jungle Cat)`、`x86_64`，北京时间 2026-10-05 16:11:03 生成 `dist/yetitiaopei-0.5.1-linux-20261005T081103Z.tar.gz`，SHA-256 为 `80315148b278b8a463a837920da12c9cbfcb9f7b07e91ebcecfba462eeabd807`。

该包内置 Node.js 24.14.0 Linux x64 官方压缩包（Node 文件 SHA-256：`dbf5b8665dec15e59e6359a517fefb47b23fdb9152d8def975b9bca3dfc6d355`），新增 AlmaLinux 一键安装脚本、systemd unit 和维护命令。客户不需要 Docker/EMQX/Node 下载；脚本只创建 `/opt/yetitiaopei`、`/var/lib/yetitiaopei`、专用账号和服务，端口冲突或已有同名路径会停止。

- [PASS] Bash `-n` syntax check passed for installer and maintenance script.
- [PASS] Actual 55.95 MB tar.gz extraction and 3 customer-package tests passed with the embedded runtime included.
- [PASS] Package SHA-256 matches `.tar.gz.sha256`.
- [NOT RUN] No AlmaLinux host or systemd/SELinux/Nginx was available locally; customer operations must run the installer and perform HTTPS/设备验收.
