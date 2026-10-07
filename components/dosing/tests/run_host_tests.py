"""Compile real closed-loop code with the project's host stubs; no hardware access."""
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile

def main():
    root = Path(__file__).resolve().parent
    compiler = os.environ.get('CC') or shutil.which('cl') or shutil.which('cc')
    if not compiler:
        raise SystemExit('Use a VS Developer Command Prompt, or set CC')
    stub = runpy.run_path(str(root.parents[1] / 'weight/tests/run_host_tests.py'))['STUB']
    with tempfile.TemporaryDirectory(prefix='yeti-dosing-') as directory:
        temp = Path(directory)
        (temp/'host_stub.h').write_text(stub,encoding='utf-8')
        for name in ['esp_err.h','esp_timer.h','esp_log.h','driver/gpio.h','driver/i2c_master.h','nvs.h',
                     'freertos/FreeRTOS.h','freertos/task.h','freertos/semphr.h']:
            p=temp/name; p.parent.mkdir(parents=True,exist_ok=True);p.write_text('#include "host_stub.h"\n',encoding='utf-8')
        for source in ['controller_host.c','service_host.c']:
            exe=temp/(source+('.exe' if os.name=='nt' else '.test'))
            inc=[temp,root.parent/'include',root.parents[1]/'actuator/include',root.parents[1]/'weight/include']
            msvc=Path(compiler).name.lower() in ('cl','cl.exe')
            flags=['/nologo','/std:c11','/utf-8','/W4','/D_CRT_SECURE_NO_WARNINGS'] if msvc else ['-std=c11','-Wall','-Wextra']
            args=[compiler,*flags,*[(('/I' if msvc else '-I')+str(p)) for p in inc],str(root/source)]
            args += ['/Fe:'+str(exe)] if msvc else ['-o',str(exe)]
            subprocess.run(args,cwd=temp,check=True);subprocess.run([str(exe)],cwd=temp,check=True)

if __name__=='__main__':main()
