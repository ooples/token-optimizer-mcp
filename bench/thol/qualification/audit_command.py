"""Record a vendor hook invoked by the real client; preserve its command/output."""
import base64
import json
import os
from pathlib import Path
import sys

from local_process import run

command = base64.b64decode(sys.argv[1]).decode()
payload = sys.stdin.read()
try:
    result = run(command, shell=True, input=payload, text=True, timeout=20, env=os.environ)
    row = {'command': command, 'input': payload, 'exit_code': result.returncode,
           'stdout': result.stdout, 'stderr': result.stderr}
except Exception as error:
    row = {'command': command, 'input': payload, 'exit_code': 124, 'error': str(error), 'stdout': '', 'stderr': str(error)}
file = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
try:
    os.write(file, (json.dumps(row) + '\n').encode())
finally:
    os.close(file)
sys.stdout.write(row['stdout'])
sys.stderr.write(row['stderr'])
raise SystemExit(row['exit_code'])
