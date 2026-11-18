"""Download checksum-verified official binaries, without executing them."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--lock', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--append', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
selected = {'squeez': 'squeez-linux-x86_64', 'edgee': 'edgee.x86_64-unknown-linux-musl',
            'lean-ctx': 'lean-ctx-x86_64-unknown-linux-musl.tar.gz',
            'cartoon': 'cartoon-x86_64-unknown-linux-musl.tar.gz',
            'lm-resizer': 'lm-resizer-0.2.6-linux-x86_64.tar.gz',
            'trs': 'trs-linux-x64', 'memphis': 'pyra-linux-amd64',
            'tokf': 'tokf-v0.2.54-x86_64-unknown-linux-gnu.tar.gz'}
rows = []
for product in json.loads(args.lock.read_text(encoding='utf-8')):
    if product['name'] not in selected:
        continue
    asset = next(a for a in product['assets'] if a['name'] == selected[product['name']])
    if not asset.get('digest'):
        raise ValueError('No official release digest; separate provenance review required')
    if asset['size'] > 150 * 1024 * 1024:
        raise ValueError('Native artifact exceeds 150 MiB cap')
    target = args.output / asset['name']
    if target.exists():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(asset['url'], timeout=60) as stream:
            data = stream.read(asset['size'] + 1)
    digest = hashlib.sha256(data).hexdigest()
    if (asset.get('digest') and 'sha256:' + digest != asset['digest']) or len(data) != asset['size']:
        raise ValueError('Release artifact checksum/size mismatch: ' + product['name'])
    target.write_bytes(data)
    rows.append({'name': product['name'], 'executable': 'pyra' if product['name'] == 'memphis' else product['name'],
                 'version': product['tag'], 'file': asset['name'],
                 'url': asset['url'], 'sha256': digest, 'bytes': len(data),
                 'upstreamDigestVerified': bool(asset.get('digest'))})
if args.append and (args.output / 'verified.json').exists():
    old = json.loads((args.output / 'verified.json').read_text())
    rows = [r for r in old if r['name'] not in {s['name'] for s in rows}] + rows
(args.output / 'verified.json').write_text(json.dumps(rows, indent=2) + '\n', encoding='utf-8')
print(json.dumps(rows, indent=2))
