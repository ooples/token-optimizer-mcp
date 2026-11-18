"""Preparation/grading ONLY. Never mounted into the isolated agent container."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

from workspace_evidence import retain, verify_archive


def runner():
    spec = importlib.util.spec_from_file_location('frozen_thol', '/home/bench/thol/runner.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.FIXTURES_OUT = Path('/frozen/fixtures/out')
    module.TRUTH_DIR = Path('/frozen/fixtures/truth')
    module.REPO_CACHE = Path('/frozen/.cache/repos')
    return module


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(task_id, workspace_path):
    rig = runner()
    task = rig.load_tasks()[task_id]
    repository = (task.get('workspace') or {}).get('repo')
    if repository:
        cache = rig.REPO_CACHE / repository
        expected = json.loads((rig.ROOT / 'repos.lock.json').read_text())[repository]['commit']
        if not (cache / '.git').exists():
            raise ValueError('Frozen repository missing; no network fallback allowed')
        actual = subprocess.check_output(['git', '-C', str(cache), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != expected:
            raise ValueError('Frozen source repository changed')
    workspace = Path(workspace_path)
    rig.build_workspace(task, workspace)
    subprocess.run(['git', 'init', '-q', str(workspace)], check=True, capture_output=True)
    prompt = task['_dir'] / 'prompt.md'
    Path('/prepared/prompt.txt').write_bytes(prompt.read_bytes())
    receipt = {'task': task_id, 'promptSha256': digest(prompt),
               'taskJsonSha256': digest(task['_dir'] / 'task.json'),
               'verifierSha256': digest(task['_dir'] / 'verify.py'),
               'rigSha256': digest(Path('/home/bench/thol/runner.py')),
               'gitRootInitialized': True}
    Path('/prepared/preparation.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)


def grade(task_id, answer_path='/prepared/answer.txt', emit_output=True):
    rig = runner()
    task = rig.load_tasks()[task_id]
    retained = Path('/retained')
    receipt = verify_archive(retained)
    with tempfile.TemporaryDirectory(prefix='independent-grade-', dir='/home/bench') as temporary:
        workspace = Path(temporary) / 'workspace'
        workspace.mkdir()
        with tarfile.open(retained / 'workspace.tar') as package:
            links = []
            for member in package.getmembers():
                relative = Path(member.name)
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError('Unsafe retained member')
                target = workspace / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if member.issym():
                    links.append((target, member.linkname))
                    continue
                if not member.isfile():
                    raise ValueError('Unsupported retained member')
                target.write_bytes(package.extractfile(member).read())
                target.chmod(member.mode & 0o777)
            for target, linkname in links:
                target.symlink_to(linkname)
        env = dict(os.environ, WORKSPACE=str(workspace), ANSWER_FILE=str(answer_path), TRUTH_DIR=str(rig.TRUTH_DIR))
        result = subprocess.run(['python3', str(task['_dir'] / 'verify.py')], env=env,
                                capture_output=True, text=True, timeout=600)
        matched = re.search(r'^score=([\d.]+)', result.stdout, re.M)
        score = float(matched.group(1)) if matched else None
        if result.returncode or score is None or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError('Verifier failed its scoring contract: ' + result.stdout[-1200:] + result.stderr[-1200:])
        report = {'task': task_id, 'score': score, 'verifierExit': result.returncode,
                          'verifierSha256': digest(task['_dir'] / 'verify.py'),
                          'workspaceArchiveSha256': receipt['archiveSha256'],
                          'detail': result.stdout + result.stderr}
        if emit_output:
            print(json.dumps(report), flush=True)
        return report


def grade_control(task_id):
    if task_id != 'log-needle-zh':
        raise ValueError('Only the selected local grader control is implemented')
    # Deliberately oracle-derived QA data, never an agent/model solution.
    facts = json.loads(Path('/frozen/fixtures/truth/log-needle-zh.json').read_text())
    with tempfile.TemporaryDirectory(prefix='grader-controls-', dir='/home/bench') as temporary:
        positive = Path(temporary) / 'positive.txt'
        negative = Path(temporary) / 'negative.txt'
        positive.write_text(json.dumps(facts))
        negative.write_text('No task answer supplied.')
        passed = grade(task_id, positive, False)
        failed = grade(task_id, negative, False)
        if passed['score'] != 1 or failed['score'] != 0:
            raise ValueError('Grader cannot discriminate the known positive and negative controls')
        print(json.dumps({'task': task_id, 'positiveScore': passed['score'], 'negativeScore': failed['score'],
                          'verifierSha256': passed['verifierSha256'], 'workspaceArchiveSha256': passed['workspaceArchiveSha256'],
                          'modelCalls': 0, 'scope': 'Oracle-derived grader QA only; not task quality or human validation'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['prepare', 'grade', 'capture', 'grade-control'])
    parser.add_argument('--task', required=True)
    parser.add_argument('--workspace', default='/prepared/workspace')
    args = parser.parse_args()
    if args.stage == 'capture':
        print(json.dumps(retain(args.workspace, '/evidence/retained')))
        verify_archive('/evidence/retained')
    elif args.stage == 'prepare':
        prepare(args.task, args.workspace)
    elif args.stage == 'grade-control':
        grade_control(args.task)
    else:
        grade(args.task)
