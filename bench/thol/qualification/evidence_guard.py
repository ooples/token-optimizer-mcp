"""Independent evidence admission. No model calls; rejects malformed run records."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def lines(path):
    return [json.loads(s) for s in path.read_text(encoding='utf-8').splitlines() if s.strip()]


def integer(value):
    return type(value) is int and value >= 0


def validate(rows, contract, evidence, hashes):
    errors = []
    expected = {(arm, task, rep) for arm in contract['arms'] for task in contract['tasks']
                for rep in range(1, contract['repetitions'] + 1)}
    seen = set()
    usage_keys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('image'), str) or not isinstance(row.get('task'), str):
            errors.append('malformed run identity')
            continue
        key = (row.get('image'), row.get('task'), row.get('rep'))
        label = ':'.join(map(str, key))
        if type(row.get('rep')) is not int or key not in expected or key in seen:
            errors.append(f'{label}: duplicate or unexpected identity')
            continue
        seen.add(key)
        arm = contract['arms'][key[0]]
        task = contract['tasks'][key[1]]
        directory_name = f'{key[0]}__{key[1]}__r{key[2]}'
        directory = evidence / directory_name
        issues = []
        try:
            original = directory / 'result.json'
            digest = hashlib.sha256(original.read_bytes()).hexdigest()
            if hashes.get(directory_name) != digest:
                issues.append('artifact hash mismatch or missing hash')
            raw = read(original)
            publication = contract.get('publication', {})
            normalized = {k: v for k, v in raw.items() if k not in publication.get('omit', [])}
            for name, value in publication.get('defaults', {}).items():
                normalized.setdefault(name, value)
            if normalized != row:
                issues.append('published row differs from original')
            score = row.get('score')
            if type(score) not in [int, float] or not math.isfinite(score) or not 0 <= score <= 1:
                issues.append('score outside [0,1]')
            elif type(row.get('success')) is not int or row['success'] != int(score >= task['successThreshold']):
                issues.append('success inconsistent with frozen task threshold')
            if row.get('status') != 'ok':
                issues.append('incomplete or infrastructure-failed run')
            identity = read(directory / 'identity.json')
            if identity.get('model') != contract['model'] or identity.get('client') != contract['client'] or identity.get('effort') != contract['effort']:
                issues.append('client/model/effort identity mismatch')
            if identity.get('task') != key[1] or identity.get('rep') != key[2]:
                issues.append('task/repetition identity mismatch')
            product = identity.get('product') or {}
            if product.get('head') != arm['head'] or product.get('tree') != arm['tree'] or product.get('dirty') is not False:
                issues.append('product provenance mismatch')
            events = lines(directory / 'stdout.jsonl')
            turns = [e['usage'] for e in events if e.get('type') == 'turn.completed' and e.get('usage')]
            if not turns or any(e.get('type') == 'turn.failed' for e in events):
                issues.append('missing completed usage or failed turn')
            totals = dict.fromkeys(usage_keys, 0)
            for usage in turns:
                if any(not integer(usage.get(k, 0) if k == 'reasoning_output_tokens' else usage.get(k)) for k in usage_keys):
                    issues.append('invalid raw Codex usage')
                    continue
                if usage['cached_input_tokens'] > usage['input_tokens']:
                    issues.append('cached input exceeds total input')
                for k in usage_keys:
                    totals[k] += usage.get(k, 0)
            if totals != row.get('usage'):
                issues.append('usage does not reconcile with raw Codex events')
            rates = contract['creditsPerMillion']
            estimate = ((totals['input_tokens'] - totals['cached_input_tokens']) * rates['uncached'] +
                        totals['cached_input_tokens'] * rates['cached'] + totals['output_tokens'] * rates['output']) / 1e6
            recorded = row.get('estimatedCredits')
            if type(recorded) not in [int, float] or not math.isfinite(recorded) or not math.isclose(estimate, recorded, rel_tol=0, abs_tol=1e-10):
                issues.append('cost estimate does not reconcile')
            hooks = lines(directory / 'hooks.jsonl')
            counts = Counter(h['entry'] for h in hooks)
            recorded_hooks = row.get('hooks') or {}
            if any(not integer(v) or counts[k] != v for k, v in recorded_hooks.items()) or any(k not in recorded_hooks for k in counts):
                issues.append('hook counters do not reconcile')
            if any(counts.get(k, 0) == 0 for k in arm['requiredHooks']):
                issues.append('missing required native hook')
            if not recorded_hooks:
                issues.append('missing recorded hook evidence')
            actual_models = []
            prompt_payloads = []
            for hook in hooks:
                payload = json.loads(hook['input'])
                if payload.get('model'):
                    actual_models.append(payload['model'])
                if hook.get('exit_code') != 0 or hook.get('stderr'):
                    issues.append('native hook execution failure')
                if hook['entry'] == 'prompt.mjs':
                    prompt_payloads.append(payload)
            if not actual_models or any(m != contract['model'] for m in actual_models):
                issues.append('missing or mismatched live model receipt')
            if arm['classifies']:
                classified = [e for e in row.get('taskEvents', []) if e.get('k') == 'classified']
                settings = row.get('selectedSettings')
                if len(classified) != 1 or len(prompt_payloads) != 1:
                    issues.append('missing or duplicate prompt classification')
                else:
                    event = classified[0]
                    payload = prompt_payloads[0]
                    if event.get('c') != task['category'] or event.get('s') != payload.get('session_id') or event.get('client') != 'codex':
                        issues.append('classification identity/category mismatch')
                    digest = hashlib.sha256(payload.get('prompt', '').encode()).hexdigest()
                    if digest != identity.get('promptSha256'):
                        issues.append('prompt hash mismatch')
                    if event.get('arm') not in ['holdout', 'classified']:
                        issues.append('invalid holdout assignment')
                    category = 'unknown' if event.get('arm') == 'holdout' else event.get('c')
                    expected_settings = arm['settingsTable'].get(category)
                    if not settings or any(s.get('category') != event.get('c') or s.get('settings') != expected_settings for s in settings):
                        issues.append('missing or mismatched selected settings')
                    states = read(directory / 'hook-state.json')
                    if not any(s.get('taskClass', {}).get('category') == event.get('c') for s in states.values() if s.get('taskClass')):
                        issues.append('saved state does not corroborate category')
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            issues.append('unreadable or malformed evidence: ' + str(error))
        errors.extend(f'{label}: {issue}' for issue in issues)
    errors.extend('missing run: ' + ':'.join(map(str, key)) for key in sorted(expected - seen))
    return {'validated': not errors, 'expectedRuns': len(expected), 'observedRuns': len(rows), 'errors': errors}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rows', type=Path, required=True)
    parser.add_argument('--contract', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--hashes', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = validate(read(args.rows), read(args.contract), args.evidence, read(args.hashes))
    except Exception as error:
        result = {'validated': False, 'errors': [str(error)]}
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['validated'] else 2)
