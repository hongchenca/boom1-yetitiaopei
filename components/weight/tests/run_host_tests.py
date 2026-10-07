"""用主机编译器与最小 ESP-IDF 替身运行真实称重服务；Windows 使用 VS Developer Command Prompt。"""
import os
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile

STUB = r'''
#ifndef WEIGHT_HOST_STUB_H
#define WEIGHT_HOST_STUB_H
#include <stdint.h>
#include <stddef.h>
typedef int esp_err_t;
typedef int gpio_num_t;
typedef int portMUX_TYPE;
typedef struct { uint64_t pin_bit_mask; int mode, pull_up_en, pull_down_en, intr_type; } gpio_config_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_STATE 1
#define ESP_ERR_INVALID_ARG 2
#define ESP_ERR_NO_MEM 3
#define ESP_ERR_TIMEOUT 4
#define ESP_ERR_INVALID_RESPONSE 5
#define ESP_ERR_INVALID_SIZE 6
#define ESP_ERR_NVS_NOT_FOUND 7
#define ESP_FAIL 8
#define NVS_READWRITE 1
#define NVS_READONLY 0
typedef unsigned nvs_handle_t;
typedef void *SemaphoreHandle_t;
#define pdTRUE 1
SemaphoreHandle_t xSemaphoreCreateMutex(void);
int xSemaphoreTake(SemaphoreHandle_t s, unsigned timeout);
void xSemaphoreGive(SemaphoreHandle_t s);
void vSemaphoreDelete(SemaphoreHandle_t s);
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle);
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *value, size_t *length);
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t length);
esp_err_t nvs_commit(nvs_handle_t handle);
void nvs_close(nvs_handle_t handle);
#define GPIO_IS_VALID_GPIO(pin) ((pin) >= 0 && (pin) <= 48)
#define GPIO_IS_VALID_OUTPUT_GPIO(pin) GPIO_IS_VALID_GPIO(pin)
#define GPIO_MODE_INPUT 1
#define GPIO_MODE_OUTPUT 2
#define GPIO_PULLUP_ENABLE 1
#define GPIO_PULLUP_DISABLE 0
#define GPIO_PULLDOWN_DISABLE 0
#define GPIO_INTR_DISABLE 0
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
#define pdPASS 1
#define pdMS_TO_TICKS(ms) (ms)
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
int64_t esp_timer_get_time(void);
void vTaskDelay(unsigned ticks);
void esp_rom_delay_us(unsigned us);
esp_err_t gpio_config(const gpio_config_t *config);
esp_err_t gpio_set_level(gpio_num_t pin, unsigned level);
int gpio_get_level(gpio_num_t pin);
int xTaskCreate(void (*task)(void *), const char *name, unsigned stack, void *arg, unsigned priority, void *handle);
#endif
'''


def main():
    """在独立临时目录创建平台替身并编译，退出时只清理本次临时产物。"""
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument('--idf-path', type=Path, default=os.environ.get('IDF_PATH'))
    options = parser.parse_args()
    compiler = os.environ.get('CC') or shutil.which('cl') or shutil.which('cc')
    if not compiler:
        raise SystemExit('Run from a VS Developer Command Prompt, or set CC to a host C compiler')
    with tempfile.TemporaryDirectory(prefix='yeti-weight-test-') as directory:
        temp = Path(directory)
        (temp / 'host_stub.h').write_text(STUB, encoding='utf-8')
        for name in ['esp_err.h', 'esp_timer.h', 'esp_rom_sys.h', 'esp_log.h', 'nvs.h', 'driver/gpio.h', 'freertos/FreeRTOS.h', 'freertos/task.h', 'freertos/semphr.h']:
            header = temp / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text('#include "host_stub.h"\n', encoding='utf-8')
        sources = ['driver_host.c', 'service_host.c']
        if options.idf_path:
            app = (root.parents[2] / 'main' / 'web_client.c').read_text(encoding='utf-8')
            start = app.index('static bool telemetry_json(')
            end = app.index('\n}\n', start) + 3
            (temp / 'telemetry_function.h').write_text(app[start:end], encoding='utf-8')
            sources.append('telemetry_host.c')
        for source in sources:
            executable = temp / (source + ('.exe' if os.name == 'nt' else '.test'))
            if Path(compiler).name.lower() in ('cl', 'cl.exe'):
                args = [compiler, '/nologo', '/std:c11', '/utf-8', '/W4', '/I' + str(temp),
                        '/I' + str(root.parent / 'include'), str(root / source), '/Fe:' + str(executable)]
            else:
                args = [compiler, '-std=c11', '-Wall', '-Wextra', '-I' + str(temp),
                        '-I' + str(root.parent / 'include'), str(root / source), '-o', str(executable)]
            if source == 'telemetry_host.c':
                cjson = options.idf_path / 'components' / 'json' / 'cJSON'
                msvc = Path(compiler).name.lower() in ('cl', 'cl.exe')
                args += [('/I' if msvc else '-I') + str(cjson),
                         ('/I' if msvc else '-I') + str(root.parents[1] / 'actuator' / 'include'),
                         ('/I' if msvc else '-I') + str(root.parents[1] / 'dosing' / 'include'),
                         ('/D' if msvc else '-D') + 'CJSON_HIDE_SYMBOLS', str(cjson / 'cJSON.c'),
                         str(root.parents[1] / 'dosing/dosing_controller.c')]
            subprocess.run(args, cwd=temp, check=True)
            subprocess.run([str(executable)], cwd=temp, check=True)


if __name__ == '__main__':
    main()
