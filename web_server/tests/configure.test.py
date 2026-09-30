"""在临时工程中验证凭据配置生成；不覆盖真实工程的私有配置头。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / 'scripts' / 'configure_web_client.py'
spec = importlib.util.spec_from_file_location('configure_web_client', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='yeti-config-')
        self.root = Path(self.directory.name)
        (self.root / 'main').mkdir()
        self.values = {'server_url': 'http://192.168.1.100:8000/console', 'wifi_ssid': 'Test "wifi"',
                       'wifi_password': 'test-password', 'device_id': 'esp32-001', 'device_token': 'a' * 48,
                       'serial_test': True}
        self.addCleanup(self.directory.cleanup)

    def generate(self):
        config = self.root / 'device.json'
        config.write_text(json.dumps(self.values), encoding='utf-8')
        with patch.object(module, '__file__', str(self.root / 'scripts' / 'configure_web_client.py')), \
             patch('sys.argv', ['configure_web_client.py', str(config)]), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            module.main()
        return (self.root / 'main' / 'web_client.local.h').read_text(encoding='utf-8')

    def test_valid_escaped_string_and_base_path(self):
        header = self.generate()
        for key, value in self.values.items():
            if key == 'serial_test':
                self.assertIn('#define WEB_CLIENT_SERIAL_TEST 1', header)
            else:
                self.assertIn('#define WEB_CLIENT_' + key.upper() + ' ' + json.dumps(value, ensure_ascii=False), header)

    def test_control_characters_rejected_without_write(self):
        for character in [chr(0), chr(10), chr(127)]:
            self.values['wifi_ssid'] = 'wifi' + character
            with self.assertRaises(SystemExit): self.generate()
            self.assertFalse((self.root / 'main' / 'web_client.local.h').exists())

    def test_bad_url_or_token_rejected(self):
        for key, value in [('server_url', 'ftp://host'), ('server_url', 'http://host/'), ('device_token', 'short')]:
            original = self.values[key]; self.values[key] = value
            with self.assertRaises(SystemExit): self.generate()
            self.values[key] = original

    def test_ssid_byte_limit(self):
        self.values['wifi_ssid'] = '测' * 11
        with self.assertRaises(SystemExit): self.generate()

if __name__ == '__main__': unittest.main()
