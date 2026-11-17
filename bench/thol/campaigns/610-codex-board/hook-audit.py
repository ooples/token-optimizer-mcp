"""Forward a shipped native hook unchanged, retaining invocation evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

payload = sys.stdin.read()
start = time.monotonic()
result = subprocess.run(['node', sys.argv[1]], input=payload, capture_output=True, text=True)
audit = {'entry': Path(sys.argv[1]).name, 'input': payload,
         'stdout': result.stdout, 'stderr': result.stderr,
         'exit_code': result.returncode, 'ms': (time.monotonic() - start) * 1000}
with Path(os.environ['BENCH_HOOK_AUDIT']).open('a') as stream:
    stream.write(json.dumps(audit) + '\n')
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
