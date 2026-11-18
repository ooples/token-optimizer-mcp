"""Capture immutable image IDs, public dependency metadata and mirror identities."""
import argparse
import json
from pathlib import Path
import subprocess

CONTAINER_QUERY = '''import json,pathlib,subprocess
def command(args):
 return subprocess.check_output(args,text=True).strip()
result={'codex':command(['codex','--version']), 'node':command(['node','--version']),
 'npmGlobal':json.loads(command(['npm','ls','--global','--depth=0','--json']))}
result['gitMirrors']={}
for name in ['caveman','ponytail']:
 path=pathlib.Path('/opt/qualification-git')/name
 if path.exists():
  result['gitMirrors'][name]=command(['git','-c','safe.directory='+str(path),'--git-dir='+str(path),'rev-parse','HEAD'])
print(json.dumps(result))
'''


def capture(output):
    rows = {}
    for version in [3, 4, 5]:
        tag = f'token-optimizer-qualification:20261118-v{version}'
        identifier = subprocess.check_output(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'], text=True).strip()
        raw = subprocess.check_output(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'python3',
                                       identifier, '-c', CONTAINER_QUERY], text=True)
        rows[tag] = {'imageID': identifier, 'metadata': json.loads(raw)}
    result = {'images': rows, 'stageImages': {
        **{stage: 'token-optimizer-qualification:20261118-v3' for stage in ['probes-v7','probes-v8','probes-v9','probes-v10','native-client-v1','native-client-v2']},
        **{stage: 'token-optimizer-qualification:20261118-v4' for stage in ['native-client-v3','native-client-v4','native-client-v5','native-client-v6','native-client-v7','probes-v13','probes-v14']},
        'native-client-v8': 'token-optimizer-qualification:20261118-v5'},
        'network': 'none', 'hostHomeMounted': False, 'providerCredentialsMounted': False}
    output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    capture(args.output)
