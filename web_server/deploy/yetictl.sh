#!/usr/bin/env bash
# 用固定路径和相同配置运行本项目维护命令，不依赖全局 Node / 当前目录。
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 root 或 sudo 执行。' >&2; exit 1; }
case "${1:-}" in
    check|backup)
        exec runuser -u yetitiaopei -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
            /opt/yetitiaopei/runtime/bin/node /opt/yetitiaopei/app/deploy/manage.cjs "$@"
        ;;
    status) exec systemctl status yetitiaopei --no-pager ;;
    logs) exec journalctl -u yetitiaopei -n 80 --no-pager ;;
    start|stop|restart) exec systemctl "$1" yetitiaopei ;;
    *) echo '用法：/opt/yetitiaopei/bin/yetictl check [HTTPS地址]|backup|status|logs|start|stop|restart' >&2; exit 1 ;;
esac
