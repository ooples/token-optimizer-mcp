"""Offline adversarial audit and complete CSV export. No model calls."""
import argparse
from collections import Counter
import copy
import csv
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from report import analyse, credits, GROUPS  # noqa: E402


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def audit(evidence, output):
    public = ROOT / 'results-v1'
    rows = read(public / 'runs.json')
    hashes = read(public / 'artifact-hashes.json')
    categories = {task: category for category, tasks in GROUPS.items() for task in tasks}
    result = {'scoredRuns': len(rows), 'checks': {}, 'failures': [], 'failedMcpCalls': {},
              'protectedPathMentions': [], 'itemTypes': {}, 'holdoutByCategory': {}}
    failed = Counter()
    types = Counter()
    holdouts = Counter()
    completed_mcp = 0
    benign_warnings = 0
    unexpected_errors = []
    web_searches = []
    exported = []
    expected_heads = {'pr610': '6c3bd71d52e7ae65d496e9b0100f474bcada5c3b',
                      'master': '1518a5d7c41f342e65dd10c89ee2595826607828'}
    for row in rows:
        key = f"{row['image']}__{row['task']}__r{row['rep']}"
        directory = evidence / key
        original = directory / 'result.json'
        observed_hash = hashlib.sha256(original.read_bytes()).hexdigest()
        if hashes.get(key) != observed_hash:
            result['failures'].append(f'{key}: original result hash mismatch')
        raw_row = read(original)
        if any(raw_row.get(k) != v for k, v in row.items()):
            result['failures'].append(f'{key}: published row differs from original')
        identity = read(directory / 'identity.json')
        if identity['product']['head'] != expected_heads[row['image']] or identity['model'] != 'gpt-6.1-sol':
            result['failures'].append(f'{key}: identity mismatch')
        events = jsonl(directory / 'stdout.jsonl')
        turns = [e['usage'] for e in events if e.get('type') == 'turn.completed' and e.get('usage')]
        observed_usage = {k: sum(t.get(k, 0) for t in turns) for k in
                          ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']}
        if observed_usage != row['usage']:
            result['failures'].append(f'{key}: Codex usage does not reconcile')
        hook_rows = jsonl(directory / 'hooks.jsonl')
        observed_hooks = Counter(h['entry'] for h in hook_rows)
        if any(observed_hooks[k] != v for k, v in row['hooks'].items()):
            result['failures'].append(f'{key}: hook invocation counts differ')
        for hook in hook_rows:
            payload = json.loads(hook['input'])
            if payload.get('model') and payload['model'] != 'gpt-6.1-sol':
                result['failures'].append(f'{key}: live hook model mismatch')
            if hook['exit_code'] or hook.get('stderr'):
                result['failures'].append(f'{key}: hook failure or stderr; inspect raw audit')
        if row['image'] == 'pr610':
            classified = [e for e in row['taskEvents'] if e.get('k') == 'classified']
            if len(classified) != 1 or classified[0]['c'] != categories[row['task']]:
                result['failures'].append(f'{key}: classification evidence mismatch')
            if classified:
                held = classified[0]['arm'] == 'holdout'
                holdouts[categories[row['task']]] += int(held)
                measured_category = 'unknown' if held else classified[0]['c']
                expected = {'outputDiscipline': measured_category != 'survey',
                            'outlineSubstitution': measured_category != 'rewrite'}
                if not row['selectedSettings'] or any(s['settings'] != expected for s in row['selectedSettings']):
                    result['failures'].append(f'{key}: selected settings mismatch')
        errors = Counter()
        for event in events:
            if event.get('type') != 'item.completed':
                continue
            item = event.get('item', {})
            types[item.get('type', 'unknown')] += 1
            if item.get('type') == 'error':
                if item.get('message') == '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.':
                    benign_warnings += 1
                else:
                    unexpected_errors.append({'run': key, 'message': item.get('message', '')[:300]})
            if item.get('type') == 'web_search':
                web_searches.append({'run': key, 'query': item.get('query')})
            if item.get('type') == 'mcp_tool_call':
                if item.get('status') == 'failed':
                    tool = item.get('tool', 'unknown')
                    failed[row['image'], tool] += 1
                    errors[tool] += 1
                elif item.get('status') == 'completed':
                    completed_mcp += 1
            if item.get('type') in ['command_execution', 'mcp_tool_call']:
                action = str(item.get('command', '')) + ' ' + json.dumps(item.get('arguments', {}))
                markers = [s for s in ['/frozen', '/campaign', '/evidence', 'TRUTH_DIR',
                           'verify.py', '/run/codex-auth.json', 'auth.json'] if s in action]
                if markers:
                    result['protectedPathMentions'].append({'run': key, 'markers': markers})
        usage = row['usage']
        exported.append({'product': row['image'], 'task': row['task'], 'category': categories[row['task']],
                         'repetition': row['rep'], 'score': row['score'], 'success': row['success'],
                         'estimated_credits': row['estimatedCredits'],
                         'input_tokens': usage['input_tokens'], 'cached_input_tokens': usage['cached_input_tokens'],
                         'uncached_input_tokens': usage['input_tokens'] - usage['cached_input_tokens'],
                         'output_tokens': usage['output_tokens'], 'reasoning_output_tokens': usage.get('reasoning_output_tokens', 0),
                         'recorded_seconds_including_grading': row['agentSeconds'],
                         'failed_mcp_calls': sum(errors.values()), 'failed_mcp_tools': json.dumps(dict(errors))})
    summary = analyse(rows)
    result['checks']['publishedSummaryReproduces'] = summary == read(public / 'summary.json')
    result['checks']['allOriginalArtifactChecksPass'] = not result['failures']
    result['checks']['noRecordedProtectedPathMentions'] = not result['protectedPathMentions']
    result['failedMcpCalls'] = {f'{image}:{tool}': n for (image, tool), n in failed.items()}
    result['completedMcpCalls'] = completed_mcp
    result['informationalHookTrustWarningItems'] = benign_warnings
    result['unexpectedErrorItems'] = unexpected_errors
    result['webSearches'] = web_searches
    result['itemTypes'] = dict(types)
    result['holdoutByCategory'] = dict(holdouts)
    result['scoredCredits'] = sum(credits(r['usage']) for r in rows)
    probes = [read(p) for p in evidence.glob('*__probe-*__r*/result.json')]
    result['recordedSetupCredits'] = sum(credits(r['usage']) for r in probes if r.get('usage'))
    missing = copy.deepcopy(rows)
    for row in missing:
        row['hooks'] = {}
        row['selectedSettings'] = []
        row['taskEvents'] = []
    bad_score = copy.deepcopy(rows)
    bad_score[0]['score'] = 99
    result['negativeControls'] = {'missingHookEvidenceAcceptedByOriginalReporter': analyse(missing)['complete'],
                                  'score99AcceptedByOriginalReporter': analyse(bad_score)['complete']}
    # Exploratory uncertainty only; never changes the pre-registered gate.
    indexed = {(r['task'], r['rep'], r['image']): r['estimatedCredits'] for r in rows}
    tasks = sorted(categories)
    rng = random.Random(20261118)
    simulations = []
    for _ in range(10000):
        ratios = []
        for task in tasks:
            reps = [rng.randrange(1, 6) for _ in range(5)]
            candidate = statistics.median(indexed[task, rep, 'pr610'] for rep in reps)
            baseline = statistics.median(indexed[task, rep, 'master'] for rep in reps)
            ratios.append(math.log(candidate / baseline))
        simulations.append(math.exp(statistics.mean(ratios)))
    simulations.sort()
    result['exploratoryPairedBootstrap'] = {'draws': 10000, 'seed': 20261118,
        'ratio95': [simulations[249], simulations[9749]],
        'scope': 'Fixed 17 tasks; paired within-task repetition resampling; does not replace gate or prove population performance.'}
    output.mkdir(parents=True, exist_ok=True)
    with (output / 'all-170-runs.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(exported[0]))
        writer.writeheader()
        writer.writerows(exported)
    task_rows = []
    for task, pair in summary['perTask'].items():
        r = {'task': task, 'category': categories[task],
             'candidate_median_credits': pair['pr610']['medianCredits'],
             'baseline_median_credits': pair['master']['medianCredits'], 'ratio': pair['ratio'],
             'change_percent': (pair['ratio'] - 1) * 100}
        for image in ['pr610', 'master']:
            group = [x for x in rows if x['image'] == image and x['task'] == task]
            r[image + '_successes'] = sum(x['success'] for x in group)
            r[image + '_all_five_credits'] = json.dumps([x['estimatedCredits'] for x in sorted(group, key=lambda x: x['rep'])])
        task_rows.append(r)
    with (output / 'all-17-tasks.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(task_rows[0]))
        writer.writeheader()
        writer.writerows(task_rows)
    dump(output / 'audit.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    result = audit(args.evidence, args.output)
    print(json.dumps(result, indent=2))
    if result['failures'] or not all(result['checks'].values()):
        sys.exit(1)
