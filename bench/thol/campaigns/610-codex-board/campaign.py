"""Sequential, resumable paired Codex campaign; no automatic failure retries."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from report import analyse
from run import TASKS

HERE = Path(__file__).resolve().parent


def source_hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.iterdir()
            if p.suffix in ['.py', '.json', '.md'] or p.name == 'Dockerfile'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--auth', required=True)
    parser.add_argument('--max-new-runs', type=int, default=170)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    images = {arm: subprocess.check_output(['docker', 'image', 'inspect', f'thol-codex:{arm}', '--format', '{{.Id}}'], text=True).strip()
              for arm in ['pr610', 'master']}
    input_manifests = []
    for image in ['pr610', 'master']:
        fingerprint = subprocess.check_output(['docker', 'run', '--rm',
                         '-v', f'{HERE}:/campaign:ro', '-v', 'thol-610-board-v2-pr610:/frozen:ro',
                         '--entrypoint', 'python3', images[image], '/campaign/input-manifest.py'], text=True)
        parsed = json.loads(fingerprint)
        input_manifests.append(parsed)
    if input_manifests[0] != input_manifests[1]:
        raise ValueError('The two images do not have identical tasks and shared inputs')
    canonical_inputs = json.dumps(input_manifests[0], sort_keys=True)
    input_manifest_path = output / 'input-manifest.json'
    if input_manifest_path.exists() and json.loads(input_manifest_path.read_text(encoding='utf-8')) != input_manifests[0]:
        raise ValueError('Frozen task inputs changed')
    input_manifest_path.write_text(canonical_inputs + '\n', encoding='utf-8')
    identity = {'protocolFiles': source_hashes(), 'images': images,
                'inputManifestSha256': hashlib.sha256(canonical_inputs.encode()).hexdigest(),
                'fixtureVolume': 'thol-610-board-v2-pr610', 'model': 'gpt-6.1-sol', 'effort': 'high',
                'plan': [{'image': image, 'task': task, 'rep': rep} for rep in range(1, 6) for task in TASKS
                         for image in (['pr610', 'master'] if rep % 2 else ['master', 'pr610'])]}
    manifest = output / 'campaign.json'
    if manifest.exists():
        if json.loads(manifest.read_text(encoding='utf-8')) != identity:
            raise ValueError('Campaign identity changed; use a new identity and record an amendment')
    else:
        manifest.write_text(json.dumps(identity, indent=2) + '\n', encoding='utf-8')
    runs = 0
    for item in identity['plan']:
        if source_hashes() != identity['protocolFiles']:
            raise ValueError('Harness changed during campaign')
        rows = [json.loads(p.read_text(encoding='utf-8')) for p in output.glob('*__r*/result.json') if '__probe-' not in p.parent.name]
        status = analyse(rows)
        (output / 'summary.json').write_text(json.dumps(status, indent=2) + '\n', encoding='utf-8')
        if status['invalid']:
            raise ValueError('Invalid attempt retained; diagnose and amend before retry')
        if status['recordedEstimatedCredits'] > 1750 or status['agentSeconds'] > 8 * 3600:
            raise ValueError('Pre-registered exposure cap reached')
        key = f"{item['image']}__{item['task']}__r{item['rep']}"
        if (output / key / 'result.json').exists():
            continue
        if (output / key).exists():
            raise ValueError('Unfinished attempt directory exists; do not overwrite')
        if runs >= args.max_new_runs:
            break
        name = 'taskclass-codex-measurement'
        command = ['docker', 'run', '--rm', '--name', name,
                   '-v', f'{HERE}:/campaign:ro', '-v', f'{output}:/evidence',
                   '-v', f'{Path(args.auth).resolve()}:/run/codex-auth.json:ro',
                   '-v', 'thol-610-board-v2-pr610:/frozen:ro', images[item['image']],
                   '--image', item['image'], '--task', item['task'], '--rep', str(item['rep'])]
        print(json.dumps({'starting': item, 'at': datetime.now(timezone.utc).isoformat()}), flush=True)
        with (output / 'driver.log').open('a', encoding='utf-8') as log:
            result = subprocess.run(command, stdout=log, stderr=log)
        if result.returncode:
            raise ValueError(f'Attempt failed: {key}; retained logs, no automatic retry')
        row = json.loads((output / key / 'result.json').read_text(encoding='utf-8'))
        print(json.dumps({'completed': item, 'success': row['success'],
                          'estimatedCredits': row['estimatedCredits'], 'usage': row['usage']}), flush=True)
        runs += 1
    subprocess.run([sys.executable, str(HERE / 'report.py'), str(output)], check=True)


if __name__ == '__main__':
    main()
