# AlmaLinux 9 客户部署 · 0.5.1

客户服务器：AlmaLinux 9.7、x86_64。**不需要 Docker、EMQX、MQTT、MySQL、Redis、Python，也不需要 `npm install`。** 本包内置官方 Node.js 24.14.0 x86_64 运行时，使用独立服务账号、独立数据目录和 systemd 运行。

客户运维在服务器上执行下面步骤，不需要把服务器账号提供给开发方。安装脚本只创建本项目自己的目录、账号和服务；不会删除或覆盖客户其他资料，不会自动修改已有 Nginx、防火墙或 SELinux。

## 1. 上传并校验

把 Linux `.tar.gz` 和同名 `.sha256` 文件上传到客户分配的空目录。文件名中的时间戳按实际收到的文件替换：

```sh
mkdir -p /opt/yeti-upload
cd /opt/yeti-upload
sha256sum -c yetitiaopei-0.5.1-linux-时间戳.tar.gz.sha256
tar -xzf yetitiaopei-0.5.1-linux-时间戳.tar.gz
cd yetitiaopei
```

如果校验失败，停止操作并重新传输原文件，不要修改压缩包。

## 2. 一条命令安装

```sh
sudo bash deploy/install-almalinux9.sh 18080
sudo /opt/yetitiaopei/bin/yetictl check
```

端口 `18080` 被占用时可以改用其他空闲端口，例如：

```sh
sudo bash deploy/install-almalinux9.sh 18081
```

脚本会检查操作系统、CPU、Node 和 SHA-256、应用文件清单、端口占用及 SQLite，然后创建：

- `/opt/yetitiaopei/app`：只读应用文件
- `/opt/yetitiaopei/runtime`：内置 Node 运行时
- `/var/lib/yetitiaopei`：数据库、账号、设备密钥和备份
- `yetitiaopei`：无登录 shell 的专用系统账号
- `yetitiaopei.service`：开机启动、异常自动重启

同名目录、账号、服务或端口已存在时，脚本会停止，不覆盖现场。

## 3. 查看首次登录信息

安装完成后，只在客户服务器本机执行：

```sh
sudo cat /var/lib/yetitiaopei/connection.json
```

使用其中的 `username` 和 `password` 登录网页，登录后立即修改密码。`devices` 里的 `token` 是 ESP32 设备密钥，不要发到群聊或放入工单；只通过约定的保密渠道交给设备维护方。

## 4. 接入现有 Nginx HTTPS

客户已有 Nginx，直接把 `deploy/nginx.conf.example` 合并到对应的 HTTPS `server {}` 中。若安装时用了 18081，把配置中的 18080 改成 18081：

```nginx
location = /console {
    return 302 /console/;
}
location ^~ /console/ {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
    client_max_body_size 32k;
}
```

然后检查并重载：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

最终访问：`https://客户域名/console/`。不要直接把 18080 暴露到公网；该端口只监听本机回环地址。HTTPS 证书必须是 ESP32 信任的证书，设备接口不能套浏览器验证码。

如果浏览器出现 502：

```sh
sudo /opt/yetitiaopei/bin/yetictl status
sudo /opt/yetitiaopei/bin/yetictl logs
sudo journalctl -u nginx -n 50 --no-pager
getenforce
```

若 SELinux 日志明确拒绝 Nginx 连接 18080，执行一次：

```sh
sudo dnf install -y policycoreutils-python-utils
sudo semanage port -a -t http_port_t -p tcp 18080 || sudo semanage port -m -t http_port_t -p tcp 18080
sudo systemctl reload nginx
```

端口使用 18081 时将上面的 18080 一并替换。只有端口标记后仍有明确 AVC 拒绝时，才由客户安全管理员评估 `httpd_can_network_connect`；不要关闭 SELinux。

## 5. 让 ESP32 接入客户服务

网页部署成功不等于设备已经迁移。向设备维护方提供：

- `https://客户域名/console`（末尾不要 `/`）
- 对应设备 ID
- 对应设备 token

当前 ESP32 的服务器地址、Wi-Fi 和 token 在固件配置中，需要维护方重新配置、构建并更新设备；网页不能直接修改设备服务器地址。设备所在网络必须能访问客户域名和授时源。

验收顺序：HTTPS 登录 → 设备显示在线 → 遥测序号持续增加 → 重量数据更新 → 刷新及断线恢复正常。泵控制和称重校准由现场人员另行验收，部署过程不会自动执行设备操作。

## 6. 日常维护

```sh
sudo /opt/yetitiaopei/bin/yetictl status
sudo /opt/yetitiaopei/bin/yetictl logs
sudo /opt/yetitiaopei/bin/yetictl restart
sudo /opt/yetitiaopei/bin/yetictl check
sudo /opt/yetitiaopei/bin/yetictl backup
```

备份目录在 `/var/lib/yetitiaopei/backups/`，包含数据库和设备身份文件，必须限制权限并复制到客户备份介质。不要执行 `rm -rf /var/lib/yetitiaopei`，不要让两个实例共用该目录。更新前先备份并确认泵已停；完整回退方法见 `deploy/README.md`。

## 出错时发给开发方

只发送以下信息，先遮挡密码、token、Cookie 和客户业务资料：

```sh
sudo /opt/yetitiaopei/bin/yetictl status
sudo journalctl -u yetitiaopei -n 80 --no-pager
sudo nginx -t
```
