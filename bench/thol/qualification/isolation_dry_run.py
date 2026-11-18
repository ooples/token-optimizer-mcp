"""No-model Docker rehearsal: agent cannot see truth; retained output regrades."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from workspace_evidence import retain, verify_archive
from lifecycle import Lifecycle


def main(image, output):
    output.mkdir(parents=True, exist_ok=False)
    ledger = Lifecycle(output / 'lifecycle', 0)
    # A clean runtime, not the old THOL image containing grader source/truth.
    identity = subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='free-isolation-') as temporary:
        base = Path(temporary)
        workspace = base / 'workspace'
        truth = base / 'truth'
        workspace.mkdir()
        truth.mkdir()
        (truth / 'expected.json').write_text('{"answer":42}')
        subprocess.run(['git', 'init', '-q', str(workspace)], check=True, capture_output=True)
        common = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                  '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp']
        agent = '''import os,pathlib,json
assert not pathlib.Path('/truth').exists()
assert not pathlib.Path('/frozen').exists()
assert not pathlib.Path('/home/bench/thol').exists()
assert not any(k.endswith(('API_KEY','AUTH_TOKEN')) and v for k,v in os.environ.items())
pathlib.Path('/workspace/answer.json').write_text(json.dumps({'answer':42}))
print('agent fixture completed; truth unavailable')
'''
        ledger.begin('agent-rehearsal', 'agent', 0)
        result = subprocess.run(common + ['-v', f'{workspace}:/workspace', identity, 'python', '-c', agent],
                                text=True, capture_output=True, timeout=30)
        ledger.finish(0, infrastructure_ok=result.returncode == 0)
        if result.returncode:
            raise RuntimeError(result.stderr)
        receipt = retain(workspace, output / 'retained')
        verify_archive(output / 'retained')
        grader = '''import json,pathlib,tarfile,tempfile
assert not pathlib.Path('/run/codex-auth.json').exists()
with tempfile.TemporaryDirectory() as directory:
 with tarfile.open('/retained/workspace.tar') as archive:
  archive.extractall(directory,filter='data')
 actual=json.loads(pathlib.Path(directory,'answer.json').read_text())
 expected=json.loads(pathlib.Path('/truth/expected.json').read_text())
 print(json.dumps({'score':int(actual==expected)}))
'''
        scores = []
        for rep in range(2):
            verify_archive(output / 'retained')
            ledger.begin('grade-' + str(rep), 'grading', 0)
            graded = subprocess.run(common + ['-v', f'{output / "retained"}:/retained:ro', '-v', f'{truth}:/truth:ro',
                                              identity, 'python', '-c', grader], text=True, capture_output=True, timeout=30)
            ledger.finish(0, infrastructure_ok=graded.returncode == 0)
            if graded.returncode:
                raise RuntimeError(graded.stderr)
            scores.append(json.loads(graded.stdout)['score'])
        if scores != [1, 1]:
            raise ValueError('Independent regrading disagrees')
        ledger.complete(report_admitted=True)
        summary = {'modelCalls': 0, 'network': 'none', 'image': identity, 'agentTruthVisible': False,
                   'graderSha256': hashlib.sha256(grader.encode()).hexdigest(), 'scores': scores,
                   'workspace': receipt, 'scope': 'architecture rehearsal, not a qualified model runner'}
        (output / 'isolation.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps({k: v for k, v in summary.items() if k != 'workspace'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    main(args.image, args.output.resolve())
