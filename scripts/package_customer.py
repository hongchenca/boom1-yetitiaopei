"""按白名单制作独立客户部署包，不读取运行数据、凭据或私有固件配置。"""
import argparse
import hashlib
import io
import json
import subprocess
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'web_server'
FILES = (
    'package.json', 'server.js', 'config.js', 'protocol.js', 'store.js',
    'console-store.js', 'console-api.js', 'backup.js', 'README.md', 'START-HERE.md',
    'start-customer.cmd', '.dockerignore',
    'public/index.html', 'public/app.css', 'public/app.js', 'public/console.js',
    'public/weight-filter.js',
    'deploy/README.md', 'deploy/manage.cjs', 'deploy/settings.example.json',
    'deploy/Dockerfile', 'deploy/compose.yaml', 'deploy/nginx.conf.example',
    'deploy/env.example', 'deploy/yetitiaopei.service.example',
)
LINUX_FILES = (
    'package.json', 'server.js', 'config.js', 'protocol.js', 'store.js',
    'console-store.js', 'console-api.js', 'backup.js', 'README.md', 'START-HERE.md',
    'public/index.html', 'public/app.css', 'public/app.js', 'public/console.js',
    'public/weight-filter.js',
    'deploy/README.md', 'deploy/manage.cjs', 'deploy/settings.example.json',
    'deploy/nginx.conf.example', 'deploy/env.example',
    'deploy/install-almalinux9.sh', 'deploy/almalinux9.service', 'deploy/yetictl.sh',
    'vendor/node-v24.14.0-linux-x64.tar.gz',
)


def git_value(*arguments):
    """git_value：记录构建来源；只读取提交号/脏状态，不打包 Git 历史。"""
    result = subprocess.run(['git', *arguments], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    return result.stdout.strip() if result.returncode == 0 else 'unavailable'


def main():
    """main：产生不可覆盖的 ZIP 和校验文件；--output 指定交付目录。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--platform', choices=('general', 'linux'), default='general')
    args = parser.parse_args()
    version = json.loads((APP / 'package.json').read_text(encoding='utf-8'))['version']
    now = datetime.now(timezone.utc)
    content = {}
    selected_files = LINUX_FILES if args.platform == 'linux' else FILES
    for name in selected_files:
        source = APP / ('LINUX-DEPLOY.md' if args.platform == 'linux' and name == 'START-HERE.md' else name)
        if source.is_symlink() or not source.is_file():
            raise SystemExit(f'Package source missing or symlink: {name}')
        raw = source.read_bytes()
        if args.platform == 'linux':
            raw = raw.replace(b'\r\n', b'\n')
        elif name == 'start-customer.cmd':
            raw = raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        content[name] = raw
    manifest = {
        'version': version, 'built_at': now.isoformat(), 'node_verified': '24.14.0',
        'platform': args.platform,
        'git_commit': git_value('rev-parse', 'HEAD'),
        'working_tree_modified': bool(git_value('status', '--porcelain')),
        'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in content.items()},
    }
    content['release-manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.platform == 'linux':
        archive = args.output / f'yetitiaopei-{version}-linux-{now:%Y%m%dT%H%M%SZ}.tar.gz'
        with archive.open('xb') as stream, tarfile.open(fileobj=stream, mode='w:gz') as output:
            for name, raw in content.items():
                item = tarfile.TarInfo('yetitiaopei/' + name)
                item.size, item.mode, item.mtime = len(raw), 0o644, int(now.timestamp())
                output.addfile(item, io.BytesIO(raw))
    else:
        archive = args.output / f'yetitiaopei-{version}-client-{now:%Y%m%dT%H%M%SZ}.zip'
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
            for name, raw in content.items():
                output.writestr('yetitiaopei/' + name, raw)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_name(archive.name + '.sha256')
    with checksum.open('x', encoding='utf-8', newline='\n') as output:
        output.write(f'{digest}  {archive.name}\n')
    print(json.dumps({'archive': str(archive.resolve()), 'sha256_file': str(checksum.resolve()),
                      'sha256': digest, 'files': len(content), 'bytes': archive.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    main()
