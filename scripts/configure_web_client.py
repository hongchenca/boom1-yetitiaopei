"""从本机配置生成 C 字符串，避免把 Wi-Fi 密码放进命令行或 CMake 日志。"""
import argparse
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

def main():
    """main：读取用户指定 JSON；只生成当前工程的网络配置头，不刷写设备。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('config', type=Path)
    args = parser.parse_args()
    values = json.loads(args.config.read_text(encoding='utf-8-sig'))
    keys = ('server_url', 'wifi_ssid', 'wifi_password', 'device_id', 'device_token')
    if any(not isinstance(values.get(key), str) for key in keys):
        parser.error('Each config field must be a string')
    if 'serial_test' in values and not isinstance(values['serial_test'], bool):
        parser.error('serial_test must be boolean')
    probe_channel = values.get('hx711_probe_channel', -1)
    if type(probe_channel) is not int or not -1 <= probe_channel <= 8:
        parser.error('hx711_probe_channel must be an integer from -1 to 8')
    if values.get('serial_test', False) or probe_channel != -1:
        parser.error('Legacy test input/probe was removed; use serial_test=false and hx711_probe_channel=-1 or omit both')
    if any(any(ord(char) < 32 or ord(char) == 127 for char in values[key]) for key in keys):
        parser.error('Configuration fields must not contain NUL or control characters')
    url = urlsplit(values['server_url'])
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment or values['server_url'].endswith('/') or len(values['server_url']) > 200:
        parser.error('server_url requires http(s), host and optional base path, without trailing slash or credentials')
    try:
        server_ip = ipaddress.ip_address(url.hostname)
    except ValueError:
        server_ip = None
    if url.hostname.lower() == 'localhost' or (server_ip and (server_ip.is_unspecified or server_ip.is_loopback)):
        parser.error('server_url must use the computer address reachable from ESP32, not 0.0.0.0 or localhost')
    if not 1 <= len(values['wifi_ssid'].encode()) <= 32 or len(values['wifi_password'].encode()) > 63:
        parser.error('Wi-Fi SSID/password exceeds device byte limits')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,48}', values['device_id']) or not re.fullmatch(r'[A-Za-z0-9_-]{24,128}', values['device_token']):
        parser.error('Invalid device identity or token')
    lines = ['/* Local development credentials. Do not commit or distribute. */', '#pragma once']
    for key in keys:
        lines.append(f'#define WEB_CLIENT_{key.upper()} {json.dumps(values[key], ensure_ascii=False)}')
    serial_test = 1 if values.get('serial_test', False) else 0
    lines.append(f'#define WEB_CLIENT_SERIAL_TEST {serial_test}')
    lines.append(f'#define WEB_CLIENT_HX711_PROBE_CHANNEL {probe_channel}')
    target = Path(__file__).resolve().parents[1] / 'main' / 'web_client.local.h'
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('Generated local firmware configuration (credentials omitted)')

if __name__ == '__main__':
    main()
