"""Credential-free CLI admission probes. Must run with Docker --network none."""
import hashlib
import base64
import shlex
from mock_codex import smoke as codex_smoke
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import re
import tomllib
import select
import signal
import time
from local_process import run as run_local


def mcp_probe(server, workspace, environment, product):
    command = [server['command']] + server.get('args', [])
    env = dict(environment, **server.get('env', {}))
    process = subprocess.Popen(command, cwd=workspace, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               start_new_session=True)
    def request(message):
        process.stdin.write(json.dumps(message) + '\n')
        process.stdin.flush()
    def receive(identifier):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], .1)
            if not ready:
                if process.poll() is not None:
                    raise RuntimeError('MCP process exited before reply')
                continue
            line = process.stdout.readline()
            if not line:
                raise RuntimeError('MCP stdout closed')
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if reply.get('id') == identifier:
                return reply
        raise TimeoutError('MCP reply timeout')
    try:
        request({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2024-11-05', 'capabilities': {},
            'clientInfo': {'name': 'free-qualification', 'version': '1'}}})
        initialized = receive(1)
        request({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        request({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        listed = receive(2)
        request({'jsonrpc': '2.0', 'id': 10, 'method': 'tools/call',
                 'params': {'name': '__missing_qualification_tool__', 'arguments': {}}})
        rejected = receive(10)
        recovery_verified = bool(rejected.get('error') or rejected.get('result', {}).get('isError'))
        known = {
            'codegraph': ('codegraph_explore', {'query': 'add', 'projectPath': str(workspace)}),
            'lean-ctx': ('ctx_read', {'path': str(workspace / 'fixture.py'), 'mode': 'full'}),
            'code-review-graph': ('query_graph_tool', {'pattern': 'file_summary', 'target': 'fixture.py', 'repo_root': str(workspace)}),
            'memphis': ('source', {'file': str(workspace / 'fixture.py'), 'name': 'add'}),
            'lm-resizer': ('lm_resizer_tool_output', {'content': 'def add(a, b):\n    return a + b\n', 'command': 'cat fixture.py', 'exit_code': 0}),
        }
        answer = None
        verified = False
        if product in known:
            name, arguments = known[product]
            request({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}})
            answer = receive(3)
            payload = answer.get('result', {})
            if not answer.get('error') and not payload.get('isError'):
                text = json.dumps(payload)
                verified = 'def add(a, b):' in text and 'return a + b' in text
                if product == 'code-review-graph':
                    def has_add(value):
                        if isinstance(value, dict):
                            return any(k in ['name', 'qualified_name', 'qualifiedName'] and isinstance(v, str) and re.search(r'(?:^|[.#:])add$', v) for k, v in value.items()) or any(has_add(v) for v in value.values())
                        if isinstance(value, list):
                            return any(has_add(v) for v in value)
                        if isinstance(value, str):
                            try:
                                return has_add(json.loads(value))
                            except ValueError:
                                return False
                        return False
                    verified = has_add(payload)
        return {'command': command, 'initialize': initialized, 'tools': listed.get('result', {}).get('tools', []),
                'error': listed.get('error') or initialized.get('error'),
                'knownAnswer': answer, 'knownAnswerVerified': verified,
                'unknownToolReply': rejected, 'failedCallRecoveryVerified': recovery_verified and verified}
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

if any(line.split()[1] == '00000000' for line in Path('/proc/net/route').read_text().splitlines()[1:] if line.split()):
    raise RuntimeError('Refusing activation probes with an external default route')
provider_keys = [k for k in os.environ if k.endswith(('API_KEY', 'AUTH_TOKEN')) and os.environ[k]]
if provider_keys:
    raise RuntimeError('Refusing probes with provider credentials present')
output = Path('/evidence')
output.mkdir(exist_ok=True)
runtime = Path(tempfile.mkdtemp(prefix='free-qualification-', dir='/home/bench'))
binary_dir = runtime / 'bin'
binary_dir.mkdir()
for artifact in json.loads(Path('/native/verified.json').read_text()):
    path = Path('/native') / artifact['file']
    if hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
        raise ValueError('Native artifact digest changed')
    executable = artifact.get('executable', artifact['name'])
    if path.name.endswith(('.tar.gz', '.tgz')):
        with tarfile.open(path) as archive:
            member = next(m for m in archive.getmembers() if m.isfile() and Path(m.name).name == executable)
            (binary_dir / executable).write_bytes(archive.extractfile(member).read())
    else:
        shutil.copyfile(path, binary_dir / executable)
    (binary_dir / executable).chmod(0o755)

built_receipts = []
if Path('/native-built/verified.json').exists():
    built_receipts = json.loads(Path('/native-built/verified.json').read_text())
    for artifact in built_receipts:
        path = Path('/native-built') / artifact['file']
        if hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
            raise ValueError('Source-built artifact digest changed')
        shutil.copyfile(path, binary_dir / artifact['name'])
        (binary_dir / artifact['name']).chmod(0o755)

recipes = {
    'cartoon': [['--version'], ['--help'], ['setup', '--help']],
    'lm-resizer': [['--version'], ['init-native-hooks', '--help'], ['install', '--help']],
    'trs': [['--version'], ['init', '--help']],
    'tokf': [['--version'], ['hook', 'install', '--help']],
    'memphis': [['--version'], ['init', '--help']],
    'token-optimizer': [['--version'], ['--help']],
    'talk-tight': [['add', '/opt/qualification-vendor/talk-tight', '--skill', 'talk-tight', '-a', 'codex', '--yes', '-g']],
    'rtk': [['--version'], ['init', '--help']],
    'squeez': [['--version'], ['setup', '--help']],
    'edgee': [['--version'], ['--help']],
    'lean-ctx': [['--version'], ['onboard', '--help']],
    'codegraph': [['--version'], ['install', '--help']],
    'graphify': [['--version'], ['install', '--help']],
    'headroom': [['--version'], ['wrap', '--help']],
    'code-review-graph': [['--version'], ['install', '--help']],
    'tokenade': [['--version'], ['install', '--help']],
    'cto': [['--version'], ['init', '--help']],
    'tokenjuice': [['--version'], ['help']],
    'claude-mem': [['--help']],
    'caveman': [['--help']],
    'ponytail': [['plugin', 'marketplace', 'add', '/opt/qualification-vendor/ponytail', '--json'],
                 ['plugin', 'add', 'ponytail@ponytail', '--json']],
    'token-saving-hooks-codex': [['--global']],
}
install = {
    'rtk': [['init', '-g', '--codex']],
    'squeez': [['setup', '--host=codex']],
    'lean-ctx': [['onboard', '--agents', 'codex', '--yes']],
    'codegraph': [['install', '--target', 'codex', '--location', 'global', '--yes', '--init']],
    'graphify': [['install', '--project', '--platform', 'codex']],
    'code-review-graph': [['install', '--platform', 'codex', '--yes'], ['build']],
    'tokenade': [['install', '--only', 'codex', '--yes']],
    'tokenjuice': [['install', 'codex']],
    'cto': [['init', '--yes', '--hooks']],
    'claude-mem': [['install', '--ide', 'codex-cli', '--setup', 'defer', '--no-auto-start']],
}
results = []
executables = {
    'talk-tight': ['skills'],
    'memphis': ['pyra'],
    'caveman': ['node', '/opt/qualification-vendor/caveman/installer/install.js'],
    'ponytail': ['codex'],
    'token-saving-hooks-codex': ['node', '/opt/qualification-vendor/token-saving-hooks-codex/setup.js'],
}
install['caveman'] = [['--only', 'codex', '--with-init']]
install['tokf'] = [['hook', 'install', '--tool', 'codex', '--global']]
install['memphis'] = [['init', '.', '--agent', 'codex', '--ticketing', 'none']]
install['lm-resizer'] = [['init-native-hooks', '--client', 'codex', '--json'],
                         ['install', '--client', 'codex', '--scope', 'global']]
install['token-optimizer'] = [['install']]
install['trs'] = [['init', 'codex', '--global']]
for product, probes in recipes.items():
    selected_products = os.environ.get('QUALIFICATION_PRODUCTS', '').split(',')
    if selected_products != [''] and product not in selected_products:
        continue
    base = runtime / product
    home = base / 'home'
    workspace = base / 'workspace'
    home.mkdir(parents=True)
    workspace.mkdir()
    (home / '.codex').mkdir()
    (home / '.claude').mkdir()
    (workspace / 'fixture.py').write_text('def add(a, b):\n    return a + b\n')
    env = dict(os.environ, HOME=str(home), CODEX_HOME=str(home / '.codex'),
               CLAUDE_CONFIG_DIR=str(home / '.claude'), XDG_CONFIG_HOME=str(home / '.config'),
               PATH=str(binary_dir) + ':' + os.environ['PATH'], CI='1',
               TOKENADE_NO_AUTO_UPDATE='1', TOKENADE_ALLOW_ROOT='0', DO_NOT_TRACK='1', NPM_CONFIG_OFFLINE='true')
    subprocess.run(['git', 'init', '-q'], cwd=workspace, env=env, check=True)
    if product == 'token-optimizer':
        # The documented auto-installer detects Codex through AGENTS.md.
        (home / '.codex/AGENTS.md').write_text('# Local Codex fixture\n')
    if product in ['caveman', 'ponytail']:
        upstream = {'caveman': 'JuliusBrussee/caveman', 'ponytail': 'DietrichGebert/ponytail'}[product]
        subprocess.run(['git', 'config', '--global', f'url.file:///opt/qualification-git/{product}.insteadOf',
                        'https://github.com/' + upstream], env=env, check=True)
        subprocess.run(['git', 'config', '--global', '--add', f'url.file:///opt/qualification-git/{product}.insteadOf',
                        'https://github.com/' + upstream + '.git'], env=env, check=True)
        subprocess.run(['git', 'config', '--global', '--add', 'safe.directory',
                        f'/opt/qualification-git/{product}'], env=env, check=True)
        env['GIT_ALLOW_PROTOCOL'] = 'file:https'
    if product == 'ponytail':
        env['CLAUDE_PLUGIN_ROOT'] = '/opt/qualification-vendor/ponytail'
    for args in probes + install.get(product, []):
        command = executables.get(product, [product]) + args
        try:
            process = run_local(command, cwd=workspace, env=env, text=True, timeout=30)
            row = {'product': product, 'command': command, 'returncode': process.returncode,
                   'stdout': process.stdout, 'stderr': process.stderr}
        except (OSError, subprocess.TimeoutExpired) as error:
            row = {'product': product, 'command': command, 'error': str(error)}
        results.append(row)
    config_files = []
    hook_calls = []
    for scope in [home / '.codex', home / '.agents', workspace / '.codex', workspace / '.agents', workspace / '.claude']:
        if not scope.exists():
            continue
        for path in scope.rglob('*'):
            if not path.is_file() or path.suffix not in ['.json', '.toml', '.md'] or path.stat().st_size > 200000:
                continue
            config_files.append({'path': str(path.relative_to(base)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
            if path.name in ['hooks.json', 'claude-codex-hooks.json']:
                try:
                    manifest = json.loads(path.read_text())
                    for event in ['SessionStart', 'UserPromptSubmit', 'PreToolUse']:
                        for group in manifest.get('hooks', {}).get(event, []):
                            matcher = group.get('matcher', '')
                            try:
                                if matcher not in ['', '*'] and not re.search(matcher, 'startup' if event == 'SessionStart' else 'Bash'):
                                    continue
                            except re.error as error:
                                hook_calls.append({'event': event, 'matcher': matcher, 'error': 'Matcher requires native-client validation: ' + str(error)})
                                continue
                            for hook in group.get('hooks', []):
                                if hook.get('type') != 'command':
                                    continue
                                payload = {'session_id': 'free-qualification-' + product, 'cwd': str(workspace),
                                           'hook_event_name': event, 'source': 'startup', 'model': 'gpt-6.1-sol',
                                           'prompt': 'Fix the fixture test', 'tool_name': 'Bash',
                                           'tool_input': {'command': 'ls -la'}}
                                try:
                                    process = run_local(hook['command'], shell=True, input=json.dumps(payload),
                                                        cwd=workspace, env=env, text=True, timeout=15)
                                    hook_calls.append({'event': event, 'exit_code': process.returncode,
                                                       'stdout': process.stdout[:4000], 'stderr': process.stderr[:2000]})
                                except Exception as error:
                                    hook_calls.append({'event': event, 'error': str(error)})
                except (ValueError, TypeError) as error:
                    hook_calls.append({'file': str(path.relative_to(base)), 'error': str(error)})
    codex_configs = []
    for path in [home / '.codex/config.toml', workspace / '.codex/config.toml']:
        if path.exists():
            try:
                codex_configs.append(tomllib.loads(path.read_text()))
            except ValueError as error:
                codex_configs.append({'parseError': str(error)})
    config_check = run_local(['codex', 'features', 'list'], cwd=workspace, env=env, text=True, timeout=15)
    legacy_hooks = []
    for config in codex_configs:
        if not isinstance(config.get('hooks'), list):
            continue
        for hook in config['hooks']:
            payload = {'session_id': 'free-legacy-' + product, 'cwd': str(workspace),
                       'hook_event_name': hook['event'], 'model': 'gpt-6.1-sol',
                       'prompt': 'Fix the fixture test', 'tool_name': 'Bash',
                       'tool_input': {'command': 'ls -la'}}
            try:
                called = run_local(hook['command'], shell=True, input=json.dumps(payload),
                                   cwd=workspace, env=env, text=True, timeout=15)
                legacy_hooks.append({'event': hook['event'], 'exit_code': called.returncode,
                                     'stdout': called.stdout, 'stderr': called.stderr})
            except Exception as error:
                legacy_hooks.append({'event': hook['event'], 'error': str(error)})
    mcp_calls = []
    for config in codex_configs:
        for name, server in config.get('mcp_servers', {}).items():
            try:
                mcp_calls.append({'name': name, **mcp_probe(server, workspace, env, product)})
            except Exception as error:
                mcp_calls.append({'name': name, 'error': str(error)})
    native_smoke = None
    native_receipts = []
    instrumentation = []
    if os.environ.get('QUALIFICATION_NATIVE_CLIENT') == '1' and config_files and config_check.returncode == 0 and product != 'cto':
        audit_file = base / 'native-hook-audit.jsonl'
        for record in config_files:
            path = base / record['path']
            if path.name not in ['hooks.json', 'claude-codex-hooks.json'] or '.claude' in path.parts:
                continue
            manifest = json.loads(path.read_text())
            for groups in manifest.get('hooks', {}).values():
                for group in groups:
                    for hook in group.get('hooks', []):
                        if hook.get('type') == 'command':
                            encoded = base64.b64encode(hook['command'].encode()).decode()
                            hook['command'] = f'python3 /qualification/audit_command.py {shlex.quote(encoded)} {shlex.quote(str(audit_file))}'
            path.write_text(json.dumps(manifest))
            instrumentation.append({'path': record['path'], 'originalSha256': record['sha256'],
                                    'instrumentedSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        native_env = dict(env)
        native_env.pop('CLAUDE_PLUGIN_ROOT', None)
        native_smoke = codex_smoke(workspace, native_env)
        if audit_file.exists():
            native_receipts = [json.loads(line) for line in audit_file.read_text().splitlines()]
    (output / (product + '-activation.json')).write_text(json.dumps({'product': product,
       'network': 'none', 'providerCredentials': False, 'configurationFiles': config_files,
       'sourceBuiltArtifacts': [r for r in built_receipts if r['name'] == product],
       'codexConfigs': codex_configs, 'hookCalls': hook_calls, 'mcpCalls': mcp_calls,
       'nativeClientSmoke': native_smoke, 'nativeHookReceipts': native_receipts, 'hookInstrumentation': instrumentation,
       'legacyHookCalls': legacy_hooks, 'nativeConfigParse': {'exit_code': config_check.returncode, 'stderr': config_check.stderr},
       'steps': [r for r in results if r['product'] == product], 'paidCalls': 0}, indent=2))
    (output / 'cli-probes.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'network': 'none', 'providerCredentials': False, 'probeCount': len(results),
                  'products': len({r['product'] for r in results}), 'paidCalls': 0,
                  'failedProbes': [{'product': r['product'], 'command': r['command'],
                                    'error': r.get('error') or r.get('stderr', '')[:200]}
                                   for r in results if r.get('error') or r.get('returncode') != 0]}, indent=2))
