"""Run one isolated Codex task against the pinned THOL inputs and grader."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

PRODUCT = Path('/opt/token-optimizer-runtime/versions/7.11.0/node_modules/@ooples/token-optimizer-mcp')
EXPECTED = {'pr610': '6c3bd71d52e7ae65d496e9b0100f474bcada5c3b',
            'master': '1518a5d7c41f342e65dd10c89ee2595826607828'}
TASKS = ['code-bugfix-py', 'code-refactor-split-py', 'log-needle-zh', 'code-iterate-tests',
         'code-feature-js', 'code-migration-py-xl', 'code-migration-py', 'code-feature-validate-py',
         'seo-audit', 'report-pdf', 'code-overview-cobra', 'code-settings-inventory-django',
         'code-comprehension-django', 'code-debug-pipeline-py', 'code-debug-ledger-py',
         'code-debug-cascade-py', 'code-rewrite-modernize-py']


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', choices=EXPECTED, required=True)
    parser.add_argument('--task', choices=TASKS)
    parser.add_argument('--rep', type=int, default=1)
    parser.add_argument('--probe', choices=['survey', 'rewrite'])
    args = parser.parse_args()
    if bool(args.task) == bool(args.probe) or not 1 <= args.rep <= 5:
        parser.error('Select one task or probe, with repetition 1..5')
    provenance = json.loads(Path('/opt/optimizer-provenance.json').read_text())
    if provenance['head'] != EXPECTED[args.image] or provenance['dirty']:
        raise ValueError('Product identity mismatch')
    client = subprocess.check_output(['codex', '--version'], text=True).strip()
    if client != 'codex-cli 0.169.0':
        raise ValueError('Codex identity mismatch')
    name = args.task or f'probe-{args.probe}'
    key = f'{args.image}__{name}__r{args.rep}'
    artifact = Path('/evidence') / key
    artifact.mkdir(parents=True, exist_ok=False)
    base = Path(tempfile.mkdtemp(prefix='task-codex-', dir='/home/bench'))
    workspace = base / 'workspace'
    home = base / 'home'
    config = home / '.codex'
    config.mkdir(parents=True)
    shutil.copyfile('/run/codex-auth.json', config / 'auth.json')
    os.chmod(config / 'auth.json', 0o600)
    module = importlib.util.spec_from_file_location('thol_runner', '/home/bench/thol/runner.py')
    rig = importlib.util.module_from_spec(module)
    module.loader.exec_module(rig)
    rig.FIXTURES_OUT = Path('/frozen/fixtures/out')
    rig.TRUTH_DIR = Path('/frozen/fixtures/truth')
    rig.REPO_CACHE = Path('/frozen/repos')
    if args.probe:
        workspace.mkdir()
        (workspace / 'README.md').write_text('Old wording: a tiny example project.\n')
        prompt = ('Survey this tiny repository and summarize its structure.' if args.probe == 'survey'
                  else 'Rewrite README.md in modern plain English, preserving its meaning.')
        task = {'timeout_s': 180}
    else:
        task = rig.load_tasks()[args.task]
        spec = task.get('workspace') or {}
        if spec.get('repo'):
            locked = json.loads((rig.ROOT / 'repos.lock.json').read_text())[spec['repo']]
            actual = subprocess.check_output(['git', '-C', str(rig.REPO_CACHE / spec['repo']),
                                              'rev-parse', 'HEAD'], text=True).strip()
            if actual != locked['commit']:
                raise ValueError('Frozen repository mismatch')
        rig.build_workspace(task, workspace)
        prompt = (task['_dir'] / 'prompt.md').read_text()
    installation = subprocess.run(['node', str(PRODUCT / 'src/scripts/install-client-hooks.mjs'),
                                   '--client', 'codex', '--dest', str(config / 'hooks')],
                                  text=True, capture_output=True, check=True)
    (artifact / 'install.txt').write_text(installation.stdout + installation.stderr)
    shipped_hooks = config / 'hooks'
    manifest = json.loads((shipped_hooks / 'hooks.json').read_text())
    for groups in manifest['hooks'].values():
        for group in groups:
            for hook in group['hooks']:
                entry = hook['command'].split('/')[-1].rstrip('"')
                hook['command'] = f'python3 /campaign/hook-audit.py "{shipped_hooks / entry}"'
                hook.pop('commandWindows', None)
    write_json(config / 'hooks.json', manifest)
    # Use the normal documented MCP + native hooks installation, locally pinned.
    (config / 'config.toml').write_text('\n'.join([
        'model = "gpt-6.1-sol"', 'model_reasoning_effort = "high"',
        '[mcp_servers.token-optimizer]', 'command = "node"',
        f'args = ["{PRODUCT}/src/plugin/launch.mjs"]',
        'required = true', 'startup_timeout_sec = 60', 'tool_timeout_sec = 120',
    ]) + '\n')
    shutil.copyfile(PRODUCT / 'src/integrations/AGENTS.md', config / 'AGENTS.md')
    env = dict(os.environ, HOME=str(home), CODEX_HOME=str(config),
               TOKEN_OPTIMIZER_HOME=str(home / '.token-optimizer'),
               TOKEN_OPTIMIZER_STATE_DIR=str(home / '.token-optimizer' / 'hook-state'),
               TOKEN_OPTIMIZER_VERSION='7.11.0',
               BENCH_HOOK_AUDIT=str(artifact / 'hooks.jsonl'))
    env.pop('TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL', None)
    if args.probe:
        env['TOKEN_OPTIMIZER_INJECTION_HOLDOUT'] = 'off'
    command = ['codex', 'exec', '--skip-git-repo-check', '--json',
               '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
               '-C', str(workspace), '-o', str(artifact / 'answer.txt'), '-']
    write_json(artifact / 'identity.json', {'product': provenance, 'client': client,
               'model': 'gpt-6.1-sol', 'effort': 'high', 'task': name, 'rep': args.rep,
               'promptSha256': hashlib.sha256(prompt.encode()).hexdigest(),
               'hooksSha256': hashlib.sha256((shipped_hooks / 'hooks.json').read_bytes()).hexdigest()})
    started = time.monotonic()
    row = {'image': args.image, 'task': name, 'rep': args.rep, 'status': 'infrastructure_error',
           'startedAt': datetime.now(timezone.utc).isoformat(), 'usage': None,
           'score': None, 'success': None, 'error': None}
    try:
        with (artifact / 'stdout.jsonl').open('w') as stdout, (artifact / 'stderr.txt').open('w') as stderr:
            result = subprocess.run(command, input=prompt, text=True, cwd=workspace, env=env,
                                    stdout=stdout, stderr=stderr, timeout=task['timeout_s'])
        events = read_jsonl(artifact / 'stdout.jsonl')
        turns = [e['usage'] for e in events if e.get('type') == 'turn.completed' and e.get('usage')]
        if turns:
            row['usage'] = {k: sum(t.get(k, 0) for t in turns) for k in
                            ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']}
        if result.returncode or not turns or any(e.get('type') == 'turn.failed' for e in events):
            raise ValueError(f'Codex failed or usage missing: exit {result.returncode}')
        if any(not isinstance(v, int) or v < 0 for v in row['usage'].values()) or row['usage']['cached_input_tokens'] > row['usage']['input_tokens']:
            raise ValueError('Invalid provider usage')
        rates = json.loads(Path('/campaign/rate-card.json').read_text())['creditsPerMillion']
        usage = row['usage']
        row['estimatedCredits'] = ((usage['input_tokens'] - usage['cached_input_tokens']) * rates['uncached'] +
                                   usage['cached_input_tokens'] * rates['cached'] +
                                   usage['output_tokens'] * rates['output']) / 1e6
        hooks = read_jsonl(artifact / 'hooks.jsonl') if (artifact / 'hooks.jsonl').exists() else []
        row['hooks'] = {entry: sum(h['entry'] == entry for h in hooks) for entry in
                        ['session-start.mjs', 'prompt.mjs', 'pre-tool.mjs', 'post-tool.mjs', 'stop.mjs']}
        if args.image == 'pr610' and not row['hooks']['prompt.mjs']:
            raise ValueError('Shipped prompt hook was not invoked')
        if any(h['exit_code'] for h in hooks):
            raise ValueError('Native hook failure; inspect audit')
        optimizer_home = home / '.token-optimizer'
        ledger = optimizer_home / 'task-classes.jsonl'
        row['taskEvents'] = read_jsonl(ledger) if ledger.exists() else []
        states = optimizer_home / 'hook-state'
        if states.exists():
            write_json(artifact / 'hook-state.json', {p.name: json.loads(p.read_text())
                       for p in states.glob('*.json')})
            if args.image == 'pr610':
                evaluation = subprocess.check_output(['node', '--input-type=module', '-e',
                    "import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; "
                    "const {sessionSettings}=await import(pathToFileURL(process.argv[1])); "
                    "const states=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); "
                    "const events=JSON.parse(process.argv[3]); "
                    "console.log(JSON.stringify(Object.values(states).filter(s=>s.taskClass).map(s=>({"
                    "category:s.taskClass.category,settings:sessionSettings(s,process.env,{sessionId:events.at(-1)?.s})}))));",
                    str(shipped_hooks / 'lib/task-settings.mjs'), str(artifact / 'hook-state.json'),
                    json.dumps(row['taskEvents'])], env=env, text=True)
                row['selectedSettings'] = json.loads(evaluation)
        if args.image == 'pr610' and not any(e.get('k') == 'classified' for e in row['taskEvents']):
            raise ValueError('Prompt hook did not record a classification')
        if args.probe:
            classified = [e for e in row['taskEvents'] if e.get('k') == 'classified']
            if args.image == 'pr610' and classified[-1]['c'] != args.probe:
                raise ValueError('Probe classified into unexpected category')
            if args.image == 'pr610':
                settings = row['selectedSettings'][-1]['settings']
                expected = {'outputDiscipline': args.probe != 'survey',
                            'outlineSubstitution': args.probe != 'rewrite'}
                if settings != expected:
                    raise ValueError('Probe did not select expected settings')
            row['score'] = None
        else:
            row['score'], detail = rig.run_verify(task, workspace, artifact / 'answer.txt')
            (artifact / 'verify.txt').write_text(detail)
            if row['score'] is None:
                raise ValueError('Verifier emitted no score')
            row['success'] = int(row['score'] >= task.get('success_threshold', 1))
        row['status'] = 'ok'
    except subprocess.TimeoutExpired:
        row['error'] = 'Task timeout; retained as infrastructure pending transcript review'
    except Exception as error:
        row['error'] = str(error)
    finally:
        row['agentSeconds'] = time.monotonic() - started
        write_json(artifact / 'result.json', row)
        # Auth/config remain only in the disposable container, never evidence.
    print(json.dumps(row), flush=True)
    return 0 if row['status'] == 'ok' else 2


if __name__ == '__main__':
    sys.exit(main())
