"""Real Codex CLI, loopback protocol fixture, no credentials or model service.

This qualifies client wiring only. Deterministic fake responses cannot measure
model quality, tokens saved, or provider compatibility.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading

from local_process import run


def verify_smoke(output):
    try:
        events = [json.loads(line) for line in output.get('stdout', '').splitlines() if line.strip()]
        requests = output.get('requests', [])
        completed = any(e.get('type') == 'turn.completed' for e in events)
        failed = any(e.get('type') == 'turn.failed' for e in events)
        known = any(e.get('type') == 'item.completed' and
                    e.get('item', {}).get('type') == 'command_execution' and
                    e['item'].get('exit_code') == 0 and
                    'def add(a, b):' in e['item'].get('aggregated_output', '') and
                    'return a + b' in e['item'].get('aggregated_output', '') for e in events)
        return bool(output.get('exit_code') == 0 and completed and not failed and known and len(requests) >= 2 and
                    all(r.get('model') == 'gpt-6.1-sol' and r.get('reasoning', {}).get('effort') == 'high' for r in requests))
    except (ValueError, TypeError):
        return False


def smoke(workspace, env):
    if any(row.split()[1] == '00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:]):
        raise RuntimeError('Mock smoke requires --network none')
    receipts = []
    class Mock(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            receipts.append({'path': self.path, 'model': request.get('model'),
                             'reasoning': request.get('reasoning'),
                             'tools': [x.get('name', x.get('type')) for x in request.get('tools', [])]})
            n = len(receipts)
            if n == 1:
                item = {'type': 'function_call', 'id': 'fc_fixture', 'call_id': 'call_fixture',
                        'name': 'exec_command', 'arguments': json.dumps({'cmd': 'cat fixture.py', 'max_output_tokens': 100})}
            else:
                item = {'type': 'message', 'id': 'msg_fixture', 'role': 'assistant',
                        'content': [{'type': 'output_text', 'text': 'Local qualification fixture complete.', 'annotations': []}]}
            response = {'id': 'resp_fixture_' + str(n), 'object': 'response', 'created_at': 0,
                        'status': 'completed', 'model': request.get('model'), 'output': [item],
                        'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15,
                                  'input_tokens_details': {'cached_tokens': 0}}}
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            messages = [
                {'type': 'response.created', 'response': dict(response, status='in_progress', output=[])},
                {'type': 'response.output_item.added', 'output_index': 0, 'item': item},
                {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                {'type': 'response.completed', 'response': response},
            ]
            for message in messages:
                self.wfile.write(('event: ' + message['type'] + '\ndata: ' + json.dumps(message) + '\n\n').encode())
            self.wfile.flush()
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    command = ['codex', 'exec', '--trust', '--json', '--dangerously-bypass-approvals-and-sandbox',
               '--dangerously-bypass-hook-trust', '-m', 'gpt-6.1-sol',
               '-c', 'model_provider="qualification_mock"',
               '-c', 'model_providers.qualification_mock.name="Offline qualification fixture"',
               '-c', f'model_providers.qualification_mock.base_url="http://127.0.0.1:{server.server_port}/v1"',
               '-c', 'model_providers.qualification_mock.wire_api="responses"',
               '-c', 'model_providers.qualification_mock.requires_openai_auth=false',
               '-c', 'model_reasoning_effort="high"', 'Inspect fixture.py to fix its tests.']
    try:
        result = run(command, cwd=workspace, env=env, text=True, timeout=45)
        output = {'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    except Exception as error:
        output = {'error': str(error)}
    finally:
        server.shutdown()
    output.update(requests=receipts, modelCalls=0, syntheticUsage=True, network='none', scope='protocol fixture, not model evaluation')
    output['verified'] = verify_smoke(output)
    return output


if __name__ == '__main__':
    import tempfile
    base = Path(tempfile.mkdtemp(dir='/home/bench', prefix='mock-codex-'))
    (base / 'fixture.py').write_text('def add(a, b):\n    return a + b\n')
    home = base / 'home'
    home.mkdir()
    (home / '.codex').mkdir()
    env = dict(os.environ, HOME=str(home), CODEX_HOME=str(home / '.codex'))
    from subprocess import run as simple_run
    simple_run(['git', 'init', '-q'], cwd=base, check=True)
    result = smoke(base, env)
    Path('/evidence/mock-codex.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
