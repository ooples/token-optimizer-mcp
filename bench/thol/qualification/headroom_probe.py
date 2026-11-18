"""Exercise the official wrapper and transport using a fake CLI and loopback upstream."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import tempfile
import threading

from local_process import run
from transport_checks import compression_preserves_failure

if any(row.split()[1] == '00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:]):
    raise RuntimeError('Run with --network none')
if any(k.endswith(('API_KEY', 'AUTH_TOKEN')) and v for k, v in os.environ.items()):
    raise RuntimeError('Credentials forbidden')

requests = []
class Mock(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path': self.path, 'body': body})
        reply = json.dumps({'id': 'resp_local_fixture', 'object': 'response',
                            'model': body['model'], 'status': 'completed',
                            'output': [], 'usage': {'input_tokens': 10, 'output_tokens': 1, 'total_tokens': 11}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)
    def log_message(self, *args):
        pass

mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=mock.serve_forever, daemon=True).start()
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    port = reservation.getsockname()[1]
base = Path(tempfile.mkdtemp(prefix='headroom-free-', dir='/home/bench'))
home = base / 'home'
home.mkdir()
binpath = base / 'bin'
binpath.mkdir()
codex = binpath / 'codex'
codex.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys,urllib.request
if '--version' in sys.argv:
 print('codex-cli 0.169.0');raise SystemExit()
noise=('progress: collecting tests; waiting for worker; unchanged status\\n'*1200)+'FAILED tests/test_sum.py::test_add - AssertionError: sentinel-481\\n'
data={'model':'gpt-6.1-sol','reasoning':{'effort':'high'},'input':[
 {'role':'user','content':'Fix the failing test.'},
 {'type':'function_call','name':'exec_command','call_id':'call_log','arguments':'{"cmd":"pytest"}'},
 {'type':'function_call_output','call_id':'call_log','output':noise}]}
target=os.environ['OPENAI_BASE_URL'].rstrip('/')+'/responses'
request=urllib.request.Request(target,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=30) as response: answer=json.loads(response.read())
config=pathlib.Path(os.environ['CODEX_HOME'],'config.toml')
pathlib.Path(os.environ['QUALIFICATION_RECEIPT']).write_text(json.dumps({'argv':sys.argv,'baseURL':os.environ['OPENAI_BASE_URL'],'request':data,'response':answer,'config':config.read_text() if config.exists() else None}))
''')
codex.chmod(0o755)
config = home / '.codex'
config.mkdir()
original = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n'
(config / 'config.toml').write_text(original)
env = dict(os.environ, HOME=str(home), CODEX_HOME=str(config), XDG_CONFIG_HOME=str(home / '.config'),
           PATH=str(binpath) + ':' + os.environ['PATH'], DO_NOT_TRACK='1',
           OPENAI_TARGET_API_URL=f'http://127.0.0.1:{mock.server_port}/v1',
           QUALIFICATION_RECEIPT=str(base / 'receipt.json'))
command = ['headroom', 'wrap', 'codex', '--port', str(port), '--', '-m', 'gpt-6.1-sol']
try:
    process = run(command, env=env, cwd=base, text=True, timeout=60)
    result = {'returncode': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr}
except Exception as error:
    result = {'error': str(error)}
receipt = json.loads((base / 'receipt.json').read_text()) if (base / 'receipt.json').exists() else None
with socket.socket() as connection:
    leaked = connection.connect_ex(('127.0.0.1', port)) == 0
verified = bool(receipt and len(requests) == 1 and requests[0]['body'].get('model') == 'gpt-6.1-sol'
                and requests[0]['body'].get('reasoning', {}).get('effort') == 'high'
                and receipt['response'].get('id') == 'resp_local_fixture')
original_bytes = len(json.dumps(receipt['request']).encode()) if receipt else None
forwarded_bytes = len(json.dumps(requests[0]['body']).encode()) if requests else None
compressed = bool(verified and compression_preserves_failure(receipt['request'], requests[0]['body']))
result.update(network='none', providerCredentials=False, modelCalls=0, upstreamRequests=requests,
              fakeCliReceipt=receipt, unchangedModelRoutingVerified=verified, proxyAliveAfterWrapper=leaked,
              configurationRestored=(config / 'config.toml').read_text() == original,
              compressionVerified=compressed, originalRequestBytes=original_bytes, forwardedRequestBytes=forwarded_bytes,
              scope='wrapper transport and one deterministic compression fixture; not model quality or measured cost')
Path('/evidence/headroom-transport.json').write_text(json.dumps(result, indent=2) + '\n')
mock.shutdown()
print(json.dumps({k:v for k,v in result.items() if k not in ['stdout','stderr','upstreamRequests','fakeCliReceipt']}))
