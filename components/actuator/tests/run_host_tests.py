"""使用主机 GPIO/I2C 替身验证真实 actuator.c 的并发、逐路停止及故障保护。"""
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile


def main():
    """复用项目的 ESP-IDF 基础替身，在独立临时目录编译并执行执行器测试。"""
    root = Path(__file__).resolve().parent
    compiler = os.environ.get('CC') or shutil.which('cl') or shutil.which('cc')
    if not compiler:
        raise SystemExit('Run from a VS Developer Command Prompt, or set CC to a host C compiler')
    stub = runpy.run_path(str(root.parents[1] / 'weight' / 'tests' / 'run_host_tests.py'))['STUB']
    with tempfile.TemporaryDirectory(prefix='yeti-actuator-test-') as directory:
        temp = Path(directory)
        (temp / 'host_stub.h').write_text(stub, encoding='utf-8')
        for name in ['esp_err.h', 'esp_timer.h', 'esp_log.h', 'driver/gpio.h',
                     'driver/i2c_master.h', 'freertos/FreeRTOS.h', 'freertos/task.h', 'freertos/semphr.h']:
            header = temp / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text('#include "host_stub.h"\n', encoding='utf-8')
        executable = temp / ('actuator.test.exe' if os.name == 'nt' else 'actuator.test')
        if Path(compiler).name.lower() in ('cl', 'cl.exe'):
            args = [compiler, '/nologo', '/std:c11', '/utf-8', '/W4', '/I' + str(temp),
                    '/I' + str(root.parent / 'include'), str(root / 'actuator_host.c'), '/Fe:' + str(executable)]
        else:
            args = [compiler, '-std=c11', '-Wall', '-Wextra', '-I' + str(temp),
                    '-I' + str(root.parent / 'include'), str(root / 'actuator_host.c'), '-o', str(executable)]
        subprocess.run(args, cwd=temp, check=True)
        subprocess.run([str(executable)], cwd=temp, check=True)


if __name__ == '__main__':
    main()
