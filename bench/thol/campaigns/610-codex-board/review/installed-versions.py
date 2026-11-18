"""Read installed CLI versions only. Never installs or launches model work."""
import json
import os
import shutil
import subprocess

commands = ['codegraph', 'lean-ctx', 'graphify', 'headroom', 'squeez', 'rtk',
            'code-review-graph', 'edgee', 'tokenade', 'cto', 'tokenjuice']
rows = []
env = dict(os.environ, CI='1', TOKENADE_NO_AUTO_UPDATE='1')
for name in commands:
    try:
        result = subprocess.run([name, '--version'], capture_output=True, text=True,
                                timeout=12, env=env)
        rows.append({'tool': name, 'path': shutil.which(name), 'returncode': result.returncode,
                     'output': (result.stdout + result.stderr).strip()[:500]})
    except (OSError, subprocess.TimeoutExpired) as error:
        rows.append({'tool': name, 'error': str(error)})
print(json.dumps(rows))
