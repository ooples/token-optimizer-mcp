import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from docker_stage import execute
from lifecycle import Lifecycle


class DockerStageTests(unittest.TestCase):
    def test_stop_marker_prevents_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Lifecycle(temporary, 0)
            (Path(temporary) / 'STOP').write_text('stop')
            with self.assertRaises(InterruptedError):
                execute(ledger, temporary, 'cancelled', 'agent',
                        ['docker', 'run', '--rm', '--network', 'none', 'unused-image'])
            self.assertEqual(ledger.state, 'stopped')
            self.assertEqual(ledger.attempts, [])

    def test_default_network_is_rejected_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Lifecycle(temporary, 0)
            with self.assertRaises(ValueError):
                execute(ledger, temporary, 'unsafe', 'agent', ['docker', 'run', '--rm', 'python:3.13-slim'])
            self.assertEqual(ledger.attempts, [])

    @unittest.skipUnless(os.environ.get('QUALIFICATION_DOCKER_TESTS') == '1', 'explicit local Docker rehearsal')
    def test_utf8_stdin_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Lifecycle(Path(temporary) / 'ledger', 0)
            text = 'prompt\r\n\u4e2d\u6587\n'
            result = execute(ledger, temporary, 'utf8', 'agent',
                ['docker', 'run', '--rm', '--network', 'none', '--interactive', 'python:3.13-slim',
                 'python', '-c', 'import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'], input=text)
            # The persisted bytes, not text-mode newline normalization, are authoritative.
            self.assertEqual((Path(temporary) / 'attempts/utf8/stdout.bin').read_bytes(), text.encode())
            self.assertIn('\u4e2d\u6587', result)

    @unittest.skipUnless(os.environ.get('QUALIFICATION_DOCKER_TESTS') == '1', 'explicit local Docker rehearsal')
    def test_timeout_stops_dispatch_and_leaves_no_owned_container(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Lifecycle(Path(temporary) / 'ledger', 0)
            with self.assertRaises(TimeoutError):
                execute(ledger, temporary, 'timeout', 'agent',
                    ['docker', 'run', '--rm', '--network', 'none', 'python:3.13-slim', 'python', '-c',
                     'import time;time.sleep(30)'], timeout=1)
            self.assertEqual(ledger.state, 'stopped')
            name = json.loads((Path(temporary) / 'attempts/timeout/command.json').read_text())['container']
            remaining = subprocess.run(['docker', 'container', 'inspect', name], capture_output=True)
            self.assertNotEqual(remaining.returncode, 0)
