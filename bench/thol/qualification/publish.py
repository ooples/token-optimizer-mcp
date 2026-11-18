"""Publish complete source/activation status, never infer savings or paid eligibility."""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from mock_codex import verify_smoke


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def publish(cache, destination):
    here = Path(__file__).parent
    matrix = load(here / 'current-matrix.json')
    source_rows = load(cache / 'source-inventory.json')
    sources = {s['name']: s for s in source_rows}
    cohorts = {}
    for key, value in load(here / 'cohort-review.json').items():
        for name in value['names']:
            if name in cohorts:
                raise ValueError('Duplicate cohort: ' + name)
            cohorts[name] = {'name': key, 'review': value['disposition']}
    names = {e['name'] for e in matrix['entries']}
    if (names != set(sources) or names != set(cohorts) or len(names) != 47 or
            len(matrix['entries']) != 47 or len(source_rows) != 47):
        raise ValueError('The entire frozen external field must be accounted for')
    destination.mkdir(parents=True, exist_ok=True)
    evidence = destination / 'evidence'
    evidence.mkdir(exist_ok=True)
    stages = ['probes-v8', 'probes-v9', 'probes-v10', 'probes-v7'] + [f'native-client-v{n}' for n in range(1, 9)]
    entries = []
    for entry in matrix['entries']:
        name = entry['name']
        source = sources[name]
        probes = []
        selected = None
        for stage in stages:
            probe = cache / stage / (name + '-activation.json')
            if not probe.exists():
                continue
            data = load(probe)
            relative = stage + '/' + probe.name
            target = evidence / relative
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(probe, target)
            probes.append({'path': 'evidence/' + relative, 'sha256': hashlib.sha256(probe.read_bytes()).hexdigest()})
            # Prefer explicit native-client receipts; otherwise later numbered
            # probe versions supersede earlier attempts without deleting failures.
            rank = 100 + int(stage.split('v')[-1]) if stage.startswith('native-client') else int(stage.split('v')[-1])
            if selected is None or rank > selected[0]:
                selected = (rank, data)
        active = selected[1] if selected else {}
        native = active.get('nativeClientSmoke') or {}
        hooks = active.get('nativeHookReceipts', [])
        mcp = active.get('mcpCalls', [])
        issues = []
        for step in active.get('steps', []):
            if step.get('error') or step.get('returncode') != 0:
                issues.append((' '.join(step['command']) + ': ' + (step.get('error') or step.get('stderr', '') or step.get('stdout', ''))[-1200:]).strip())
        if active.get('nativeConfigParse', {}).get('exit_code', 0) != 0:
            issues.append(('Native Codex configuration fails to load: ' + active['nativeConfigParse']['stderr']).strip())
        if native and not verify_smoke(native):
            issues.append('Real-client mock-provider smoke failed: ' + str(native.get('error') or native.get('stderr')))
        if any(h.get('exit_code') != 0 for h in hooks):
            issues.append('Real-client hook invocation failed; inspect receipts')
        if name == 'memphis':
            issues.append('Official v1.1.0 release binary reports version "dev". Archive provenance is pinned; semantic runtime version is not corroborated.')
        if name == 'token-optimizer':
            issues.append('Official npm package 0.2.2 CLI help reports v0.2.1. Preserve both identities; do not silently call this a verified runtime version match.')
        row = {'name': name, 'latestObserved': entry.get('latestObserved'), 'cohort': cohorts[name],
               'source': {k: source[k] for k in ['status', 'repository', 'package', 'version', 'ref', 'source', 'sha256', 'integrity', 'error'] if k in source},
               'sourceVerified': source.get('status') == 'source_verified',
               'activationAttempted': bool(active), 'evidence': probes,
               'configurationFiles': len(active.get('configurationFiles', [])),
               'runtimeVersionOutputs': [s.get('stdout', '')[:500] for s in active.get('steps', []) if '--version' in s['command']],
               'sourceBuiltArtifacts': active.get('sourceBuiltArtifacts', []),
               'mcpKnownAnswersPassed': sum(m.get('knownAnswerVerified') is True for m in mcp),
               'realClientMockSmokePassed': verify_smoke(native),
               'realClientNativeHookCalls': len(hooks), 'realClientHookFailures': sum(h.get('exit_code') != 0 for h in hooks),
               'issues': issues, 'paidAdmitted': False,
               'pending': 'Complete product-specific known-answer, failure recovery, teardown, provider-routing and accounting review; then review paid cohort scope/budget.'}
        entries.append(row)
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'products': len(entries),
              'sourceVerified': sum(e['sourceVerified'] for e in entries),
              'activationAttempted': sum(e['activationAttempted'] for e in entries),
              'realClientMockSmokePassed': sum(e['realClientMockSmokePassed'] for e in entries),
              'paidAdmitted': 0, 'paidModelCallsDuringQualification': 0, 'entries': entries}
    (destination / 'qualification-matrix.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    with (destination / 'qualification-matrix.csv').open('w', encoding='utf-8', newline='') as stream:
        fields = ['name', 'latestObserved', 'cohort', 'sourceVerified', 'activationAttempted', 'realClientMockSmokePassed',
                  'realClientNativeHookCalls', 'mcpKnownAnswersPassed', 'paidAdmitted', 'issues']
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for entry in entries:
            row = {k: entry[k] for k in fields}
            row.update(cohort=entry['cohort']['name'], issues='; '.join(' '.join(issue.split()) for issue in entry['issues']))
            writer.writerow(row)
    lines = ['# Full field: free qualification status', '',
             'No new paid benchmark was run. Mock-provider token receipts are synthetic and excluded from all savings/cost results.', '',
             f"{result['sourceVerified']}/47 sources verified; {result['activationAttempted']} activation attempts; {result['realClientMockSmokePassed']} real-client mock smokes passed; **0 paid admissions**.", '',
             'These are admission stages, not competitor rankings. All 47 entries remain visible. Configuration or a successful installer exit is insufficient.', '',
             '| Product | Latest observed | Cohort for review | Source | Real Codex mock smoke | Native hook calls | MCP known answers |',
             '|---|---|---|---|---|---:|---:|']
    for entry in entries:
        lines.append(f"| {entry['name']} | {entry['latestObserved']} | {entry['cohort']['name']} | {'verified' if entry['sourceVerified'] else 'unresolved'} | {'passed' if entry['realClientMockSmokePassed'] else 'pending / see issues'} | {entry['realClientNativeHookCalls']} | {entry['mcpKnownAnswersPassed']} |")
    lines += ['', '## Product issues and remaining work', '']
    for entry in entries:
        lines += ['### ' + entry['name'], '', entry['cohort']['review'], '']
        if entry['issues']:
            lines += ['```text', '\n'.join(entry['issues']), '```', '']
        if entry['evidence']:
            lines += ['Evidence: ' + ', '.join(f"[{p['path']}]({p['path']})" for p in entry['evidence']), '']
        lines += [entry['pending'], '']
    (destination / 'STATUS.md').write_text('\n'.join(line.rstrip() for line in lines).rstrip() + '\n', encoding='utf-8')
    (destination / 'source-inventory.json').write_text(json.dumps([{k:v for k,v in s.items() if k != 'packageDefinitions'} for s in sources.values()], indent=2) + '\n', encoding='utf-8')
    shutil.copyfile(cache / 'native/verified.json', destination / 'native-verified.json')
    shutil.copyfile(cache / 'isolation-v1/isolation.json', destination / 'isolation.json')
    for stage in ['probes-v7', 'probes-v13', 'probes-v14']:
        transport = cache / stage / 'headroom-transport.json'
        if transport.exists():
            target = evidence / stage / transport.name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(transport, target)
    if (cache / 'native-built/verified.json').exists():
        shutil.copyfile(cache / 'native-built/verified.json', destination / 'native-source-built.json')
    print(json.dumps({k:v for k,v in result.items() if k != 'entries'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    publish(args.cache, args.output)
