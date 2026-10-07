#!/usr/bin/env bash
# 首次安装 AlmaLinux 9 / x86_64；所有写入仅限下列本项目目录、账号和服务。
set -Eeuo pipefail
umask 022

SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALL_ROOT=/opt/yetitiaopei
DATA_ROOT=/var/lib/yetitiaopei
SERVICE=yetitiaopei.service
UNIT=/etc/systemd/system/yetitiaopei.service
NODE_ARCHIVE="$SOURCE/vendor/node-v24.14.0-linux-x64.tar.gz"
NODE_SHA256=dbf5b8665dec15e59e6359a517fefb47b23fdb9152d8def975b9bca3dfc6d355
PORT=${1:-18080}
stage=preflight

# die：输出可操作错误并停止，不终止其他服务，也不删除现有资料。
die() { echo "安装停止：$*" >&2; exit 1; }

# failed：保留失败现场，避免自动清理误伤已有数据；参数为失败退出码。
failed() {
    local status=$1
    echo "安装未完成（阶段：$stage，退出码：$status）。请保留报错交给维护方，不要删除数据目录。" >&2
    if [[ $stage == service ]]; then
        echo '查看日志：journalctl -u yetitiaopei -n 60 --no-pager' >&2
    fi
    exit "$status"
}
trap 'failed "$?"' ERR

[[ $# -le 1 ]] || die '用法：bash deploy/install-almalinux9.sh [端口，默认 18080]'
[[ $EUID -eq 0 ]] || die '请由客户运维使用 root 或 sudo bash 执行。'
[[ -r /etc/os-release ]] || die '无法确认操作系统。'
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == almalinux && ${VERSION_ID:-} == 9.* ]] || die '此安装包仅用于 AlmaLinux 9.x。'
[[ $(uname -m) == x86_64 ]] || die '此安装包仅用于 x86_64。'
[[ -d /run/systemd/system ]] || die '未检测到运行中的 systemd。'
[[ $PORT =~ ^[0-9]{4,5}$ ]] || die '请指定 1024～65535 的整数端口。'
PORT=$((10#$PORT))
(( PORT >= 1024 && PORT <= 65535 )) || die '端口必须为 1024～65535。'
for tool in tar sha256sum install getent useradd groupadd runuser systemctl ss cp chmod chown sleep; do
    command -v "$tool" >/dev/null || die "缺少系统命令 $tool，请客户运维补齐后再安装。"
done
for target in "$INSTALL_ROOT" "$DATA_ROOT" "$UNIT"; do
    [[ ! -e $target && ! -L $target ]] || die "$target 已存在；本脚本仅做全新安装，不覆盖或升级。"
done
[[ $(systemctl show "$SERVICE" -p LoadState --value) == not-found ]] || die '已存在同名系统服务，请维护方核对。'
if getent passwd yetitiaopei >/dev/null || getent group yetitiaopei >/dev/null; then
    die '已存在 yetitiaopei 账号或组，请维护方核对，不复用未知账号。'
fi
listeners=$(ss -H -ltn "sport = :$PORT")
[[ -z $listeners ]] || die "端口 $PORT 已占用；可改用 bash deploy/install-almalinux9.sh 18081。"
[[ -f $NODE_ARCHIVE && ! -L $NODE_ARCHIVE ]] || die '离线 Node 运行时缺失，请重新解压完整专用包。'
echo "$NODE_SHA256  $NODE_ARCHIVE" | sha256sum -c -

stage=runtime
install -d -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/runtime" "$INSTALL_ROOT/app" "$INSTALL_ROOT/bin"
tar -xzf "$NODE_ARCHIVE" --no-same-owner --strip-components=1 -C "$INSTALL_ROOT/runtime"
NODE_BIN="$INSTALL_ROOT/runtime/bin/node"
[[ $("$NODE_BIN" --version) == v24.14.0 ]] || die 'Node 运行时版本异常。'
"$NODE_BIN" -e "require('node:sqlite'); console.log('Node / SQLite 运行时检查通过');"
"$NODE_BIN" "$SOURCE/deploy/manage.cjs" verify

stage=application
# 只复制清单内文件；不复制解压目录中后来出现的账号配置、数据库或其他资料。
"$NODE_BIN" - "$SOURCE" "$INSTALL_ROOT/app" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [source, destination] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'release-manifest.json'), 'utf8'));
for (const name of [...Object.keys(manifest.files), 'release-manifest.json']) {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('无效清单路径');
  const from = path.join(source, name), to = path.join(destination, name);
  if (!fs.lstatSync(from).isFile()) throw new Error('应用文件必须为普通文件');
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o644);
}
NODE
"$NODE_BIN" "$INSTALL_ROOT/app/deploy/manage.cjs" verify
groupadd --system yetitiaopei
useradd --system --gid yetitiaopei --home-dir "$DATA_ROOT" --no-create-home --shell /sbin/nologin yetitiaopei
install -d -m 0700 -o yetitiaopei -g yetitiaopei "$DATA_ROOT"
cat > "$INSTALL_ROOT/app/deploy/settings.json" <<JSON
{
  "APP_HOST": "127.0.0.1",
  "APP_PORT": $PORT,
  "APP_BASE_PATH": "/console",
  "APP_DATA_DIR": "$DATA_ROOT",
  "APP_SECURE_COOKIE": true
}
JSON
install -m 0755 "$INSTALL_ROOT/app/deploy/yetictl.sh" "$INSTALL_ROOT/bin/yetictl"
install -m 0644 "$INSTALL_ROOT/app/deploy/almalinux9.service" "$UNIT"
if command -v restorecon >/dev/null; then
    restorecon -R "$INSTALL_ROOT" "$DATA_ROOT" "$UNIT"
fi
# 与 systemd 使用同一专用账号和 JSON，清除运维 shell 中旧的 APP_* / NODE_OPTIONS。
runuser -u yetitiaopei -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
    "$NODE_BIN" "$INSTALL_ROOT/app/deploy/manage.cjs" init

stage=service
systemctl daemon-reload
systemctl start "$SERVICE"
healthy=0
for attempt in {1..20}; do
    if "$INSTALL_ROOT/bin/yetictl" check >/dev/null 2>&1; then healthy=1; break; fi
    systemctl is-active --quiet "$SERVICE" || break
    sleep 1
done
if (( healthy != 1 )); then
    systemctl stop "$SERVICE"
    die '本机健康检查未通过，已停止本项目服务；运行 journalctl -u yetitiaopei -n 60 --no-pager 查看原因。'
fi
systemctl enable "$SERVICE"
"$INSTALL_ROOT/bin/yetictl" check
echo "安装完成：127.0.0.1:$PORT/console/，已设开机启动和异常退出重启。"
echo '首次登录信息：由客户在服务器本机查看 /var/lib/yetitiaopei/connection.json'
echo '下一步：将包内 Nginx 片段合并到客户 HTTPS 站点。尚未修改现有代理、防火墙或 SELinux 策略。'
