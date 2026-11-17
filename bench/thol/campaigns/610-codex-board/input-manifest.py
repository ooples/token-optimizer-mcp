"""Fingerprint the shared task inputs; never accesses client authentication."""
import hashlib
import json
from pathlib import Path
import subprocess

files = {}
for root in [Path('/frozen/fixtures/out'), Path('/frozen/fixtures/truth'), Path('/home/bench/thol/tasks')]:
    for path in sorted(root.rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            files[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
repos = {path.name: subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
         for path in sorted(Path('/frozen/repos').iterdir()) if (path / '.git').exists()}
print(json.dumps({'files': files, 'repositories': repos}, sort_keys=True))
