"""Supervise a network-denied rehearsal stage and clean up its owned container."""
import hashlib
import json
from pathlib import Path
import subprocess
import time


def execute(ledger, output, key, phase, command, *, input=None, timeout=900):
    if command[:2] != ['docker', 'run'] or command.count('--network') != 1 or command[command.index('--network') + 1] != 'none':
        raise ValueError('Rehearsal stages require explicit Docker --network none')
    if (ledger.directory / 'STOP').exists():
        ledger.stop('Operator stop marker present before dispatch')
        raise InterruptedError('Stop requested')
    logs = Path(output) / 'attempts' / key.replace(':', '__')
    logs.mkdir(parents=True, exist_ok=False)
    name = 'qualification-stage-' + hashlib.sha256((str(Path(output).resolve()) + key).encode()).hexdigest()[:20]
    owned = command[:2] + ['--name', name] + command[2:]
    (logs / 'command.json').write_text(json.dumps({'container': name, 'command': owned, 'timeoutSeconds': timeout}, indent=2))
    ledger.begin(key, phase, 0)
    process = None
    try:
        with (logs / 'stdout.bin').open('wb') as stdout, (logs / 'stderr.bin').open('wb') as stderr:
            process = subprocess.Popen(owned, stdin=subprocess.PIPE if input is not None else None, stdout=stdout, stderr=stderr)
            deadline = time.monotonic() + timeout
            pending = input.encode('utf-8') if isinstance(input, str) else input
            while True:
                if (ledger.directory / 'STOP').exists():
                    raise InterruptedError('Operator stop requested')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Stage deadline reached')
                try:
                    process.communicate(input=pending, timeout=min(2, remaining))
                    break
                except subprocess.TimeoutExpired:
                    pending = None
                    ledger.save('Stage still running; heartbeat only, not a delivered chat update')
        ledger.finish(0, infrastructure_ok=process.returncode == 0)
        if process.returncode:
            raise RuntimeError((logs / 'stderr.bin').read_text(encoding='utf-8', errors='replace')[-3000:])
        return (logs / 'stdout.bin').read_text(encoding='utf-8')
    except Exception:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        if ledger.active is not None:
            ledger.finish(0, infrastructure_ok=False)
        raise
    finally:
        # Killing the Docker CLI alone does not guarantee its container stopped.
        subprocess.run(['docker', 'rm', '--force', name], capture_output=True, timeout=20)
