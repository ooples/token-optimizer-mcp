"""Rehearse the actual frozen 17-task pipeline without any AI/model service."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

from lifecycle import Lifecycle
from workspace_evidence import retain, verify_archive
from docker_stage import execute as docker_execute

HERE = Path(__file__).resolve().parent
FAKE_AGENT = '''import hashlib,json,os,pathlib,sys
for path in ['/truth','/frozen','/home/bench/thol','/qualification','/run/codex-auth.json']:
 assert not pathlib.Path(path).exists(),path
assert not any(k.endswith(('API_KEY','AUTH_TOKEN')) and v for k,v in os.environ.items())
assert pathlib.Path('/workspace/.git').exists()
prompt=sys.stdin.buffer.read()
pathlib.Path('/workspace/.qualification-rehearsal').write_text('isolated no-model agent output\\n')
print(json.dumps({'promptSha256':hashlib.sha256(prompt).hexdigest(),'truthVisible':False,'modelCalls':0}))
'''


def image_id(image):
    return subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], text=True).strip()


def exercise(output, grader_image, agent_image):
    output.mkdir(parents=True, exist_ok=False)
    ledger = Lifecycle(output / 'lifecycle', 0)
    tasks = json.loads((HERE / '610-evidence-contract.json').read_text())['tasks']
    grader = image_id(grader_image)
    agent = image_id(agent_image)
    uid = subprocess.check_output(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'id', grader, '-u'], text=True).strip()
    gid = subprocess.check_output(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'id', grader, '-g'], text=True).strip()
    if not uid.isdigit() or not gid.isdigit():
        raise ValueError('Cannot establish preparation filesystem identity')
    frozen = ['-v', 'thol-610-board-v2-pr610:/frozen:ro']
    helper = ['-v', f'{HERE}:/qualification:ro']
    rows = []
    volumes = {}
    def execute(key, phase, command, *, input=None, timeout=900):
        return docker_execute(ledger, output, key, phase, command, input=input, timeout=timeout)
    try:
        for task in tasks:
            directory = output / task
            directory.mkdir()
            prepared = directory / 'prepared'
            prepared.mkdir()
            volume = 'qualification-workspace-' + hashlib.sha256((str(output) + task).encode()).hexdigest()[:20]
            # Never reuse or remove a pre-existing volume with this name.
            exists = subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True)
            if exists.returncode == 0:
                raise ValueError('Workspace volume already exists')
            ledger.begin(task + ':volume', 'setup', 0)
            created = subprocess.run(['docker', 'volume', 'create', '--label', 'qualification=' + volume, volume], capture_output=True)
            ledger.finish(0, infrastructure_ok=created.returncode == 0)
            if created.returncode:
                raise RuntimeError('Cannot create isolated workspace volume')
            volumes[volume] = False
            common = ['docker', 'run', '--rm', '--network', 'none']
            volume_mount = ['--mount', f'type=volume,source={volume},target=/staging']
            execute(task + ':ownership', 'setup', common + volume_mount +
                    ['--user', '0:0', '--entrypoint', 'chown', grader, uid + ':' + gid, '/staging'])
            preparation = execute(task + ':prepare', 'setup', common + frozen + helper +
                volume_mount + ['-v', f'{prepared}:/prepared', '--entrypoint', 'python3', grader,
                 '/qualification/task_stage.py', 'prepare', '--task', task, '--workspace', '/staging/workspace'])
            (directory / 'prepare.log').write_text(preparation, encoding='utf-8')
            prompt = (prepared / 'prompt.txt').read_bytes()
            stdout = execute(task + ':agent', 'agent', common +
                ['--interactive', '--read-only', '--user', uid + ':' + gid, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp',
                 '--mount', f'type=volume,source={volume},target=/workspace,volume-subpath=workspace', '-w', '/workspace',
                 agent, 'python', '-c', FAKE_AGENT], input=prompt, timeout=30)
            agent_receipt = json.loads(stdout)
            (directory / 'agent.json').write_text(stdout, encoding='utf-8')
            original = json.loads((prepared / 'preparation.json').read_text())
            if agent_receipt['promptSha256'] != original['promptSha256']:
                raise ValueError('Prompt changed at the agent boundary')
            (prepared / 'answer.txt').write_text('Offline isolation rehearsal; intentionally no model task solution.\n')
            retained = directory / 'retained'
            execute(task + ':retain', 'setup', common + helper + volume_mount +
                    ['-v', f'{directory}:/evidence', '--entrypoint', 'python3', grader,
                     '/qualification/task_stage.py', 'capture', '--task', task, '--workspace', '/staging/workspace'])
            archive = verify_archive(retained)
            volumes[volume] = True
            scores = []
            for repetition in [1, 2]:
                verify_archive(retained)
                graded = execute(task + ':grade' + str(repetition), 'grading', common + frozen + helper +
                    ['-v', f'{retained}:/retained:ro', '-v', f'{prepared}:/prepared:ro', '--entrypoint', 'python3', grader,
                     '/qualification/task_stage.py', 'grade', '--task', task])
                data = json.loads(graded)
                if data['verifierSha256'] != original['verifierSha256'] or data['workspaceArchiveSha256'] != archive['archiveSha256']:
                    raise ValueError('Grader or retained input identity changed')
                scores.append(data['score'])
                (directory / f'grade-{repetition}.json').write_text(graded, encoding='utf-8')
            if scores[0] != scores[1]:
                raise ValueError('Independent regrading disagrees')
            # Final bytes are verified outside the live workspace before removal.
            subprocess.run(['docker', 'volume', 'rm', volume], check=True, capture_output=True)
            del volumes[volume]
            rows.append({'task': task, 'scores': scores, 'agentTruthVisible': False, 'modelCalls': 0,
                         'workspaceArchiveSha256': archive['archiveSha256'], 'preparation': original})
            (output / 'progress.json').write_text(json.dumps({'completed': len(rows), 'total': len(tasks), 'rows': rows}, indent=2))
            print(json.dumps({'completed': len(rows), 'task': task, 'scores': scores}), flush=True)
        ledger.complete(report_admitted=True)
        result = {'complete': True, 'tasks': len(rows), 'modelCalls': 0, 'syntheticAgent': True, 'network': 'none',
                  'agentImageID': agent, 'graderImageID': grader, 'rows': rows,
                  'finishedUTC': datetime.now(timezone.utc).isoformat(),
                  'scope': 'Actual fixture/retention/grader pipeline rehearsal; scores are not model-quality results'}
    except Exception as error:
        ledger.stop(str(error))
        result = {'complete': False, 'tasks': len(rows), 'modelCalls': 0, 'rows': rows, 'error': str(error)}
    # Failed workspace volumes are retained for inspection, never silently lost.
    result['retainedVolumes'] = list(volumes)
    (output / 'full-suite-isolation.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k != 'rows'}), flush=True)
    return result['complete']


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--grader-image', default='thol-codex:pr610')
    parser.add_argument('--agent-image', default='python:3.13-slim')
    args = parser.parse_args()
    raise SystemExit(0 if exercise(args.output.resolve(), args.grader_image, args.agent_image) else 2)
