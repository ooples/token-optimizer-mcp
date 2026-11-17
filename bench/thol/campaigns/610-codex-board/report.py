"""Report all frozen Codex pairs, withholding verdicts on incomplete data."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import statistics

GROUPS = {
    'fix': ['code-bugfix-py', 'code-iterate-tests', 'code-debug-pipeline-py', 'code-debug-ledger-py', 'code-debug-cascade-py'],
    'build': ['code-feature-js', 'code-feature-validate-py', 'code-migration-py', 'code-migration-py-xl', 'code-refactor-split-py'],
    'survey': ['code-comprehension-django', 'code-overview-cobra', 'code-settings-inventory-django', 'report-pdf', 'seo-audit'],
    'locate': ['log-needle-zh'], 'rewrite': ['code-rewrite-modernize-py'],
}
TASKS = set(t for tasks in GROUPS.values() for t in tasks)


def credits(usage):
    names = ['input_tokens', 'cached_input_tokens', 'output_tokens']
    if not usage or any(type(usage.get(k)) is not int or usage[k] < 0 for k in names):
        raise ValueError('Missing or invalid usage')
    if usage['cached_input_tokens'] > usage['input_tokens']:
        raise ValueError('Cached input exceeds total input')
    return ((usage['input_tokens'] - usage['cached_input_tokens']) * 50 +
            usage['cached_input_tokens'] * 2.5 + usage['output_tokens'] * 250) / 1e6


def analyse(rows):
    expected = {(image, task, rep) for image in ['pr610', 'master'] for task in TASKS for rep in range(1, 6)}
    indexed = {}
    result = {'complete': False, 'measuredRuns': 0, 'missing': [], 'invalid': [], 'perTask': {},
              'metric': 'estimated standard GPT-6.1 Sol credits; not actual billed cost'}
    for row in rows:
        key = (row['image'], row['task'], row['rep'])
        if key not in expected or key in indexed:
            raise ValueError('Unexpected or duplicate task measurement')
        indexed[key] = row
        try:
            estimate = credits(row.get('usage'))
            if row['status'] != 'ok' or row.get('success') not in [0, 1] or not math.isfinite(row.get('score', float('nan'))):
                raise ValueError('Run did not complete grading')
            if not math.isclose(estimate, row.get('estimatedCredits', -1), abs_tol=1e-10):
                raise ValueError('Credit estimate does not reconcile')
        except (ValueError, TypeError) as error:
            result['invalid'].append({'key': key, 'error': str(error)})
    result['measuredRuns'] = len(rows)
    result['missing'] = sorted(expected - indexed.keys())
    result['recordedEstimatedCredits'] = sum(credits(r['usage']) for r in rows if r.get('usage'))
    result['agentSeconds'] = sum(r.get('agentSeconds', 0) for r in rows)
    if result['missing'] or result['invalid']:
        return result
    for task in sorted(TASKS):
        pair = {}
        for image in ['pr610', 'master']:
            group = [indexed[image, task, rep] for rep in range(1, 6)]
            costs = [credits(r['usage']) for r in group]
            pair[image] = {'medianCredits': statistics.median(costs), 'minCredits': min(costs),
                           'maxCredits': max(costs), 'successes': sum(r['success'] for r in group),
                           'medianTotalTokens': statistics.median(r['usage']['input_tokens'] + r['usage']['output_tokens'] for r in group),
                           'totals': {k: sum(r['usage'][k] for r in group) for k in
                                      ['input_tokens', 'cached_input_tokens', 'output_tokens']}}
        if pair['master']['medianCredits'] <= 0 or pair['pr610']['medianCredits'] <= 0:
            result['invalid'].append({'task': task, 'error': 'Nonpositive task cost'})
            return result
        pair['ratio'] = pair['pr610']['medianCredits'] / pair['master']['medianCredits']
        result['perTask'][task] = pair
    result['complete'] = True
    result['geometricMeanRatio'] = math.exp(statistics.mean(math.log(p['ratio']) for p in result['perTask'].values()))
    result['successes'] = {image: sum(p[image]['successes'] for p in result['perTask'].values()) for image in ['pr610', 'master']}
    result['numericGatePassed'] = result['geometricMeanRatio'] <= 1 and result['successes']['pr610'] >= result['successes']['master']
    result['outliersRequiringReview'] = [t for t, p in result['perTask'].items() if not .67 <= p['ratio'] <= 1.5]
    result['categories'] = {}
    for category, tasks in GROUPS.items():
        ratio = math.exp(statistics.mean(math.log(result['perTask'][t]['ratio']) for t in tasks))
        threshold = 1.03 if category in ['survey', 'rewrite'] else 1.05
        result['categories'][category] = {'ratio': ratio, 'threshold': threshold,
            'disposition': ('remove override' if category in ['survey', 'rewrite'] else 'investigate overhead') if ratio > threshold else 'within threshold'}
    events = [e for r in rows if r['image'] == 'pr610' for e in r.get('taskEvents', []) if e.get('k') == 'classified']
    result['classificationEvents'] = dict(Counter((e.get('c', 'unknown') for e in events)))
    result['heldoutEvents'] = sum(e.get('arm') == 'holdout' for e in events)
    result['classifiedEvents'] = len(events)
    return result


def selftest():
    def data(factor=1, success=1):
        rows = []
        for image in ['pr610', 'master']:
            for task in TASKS:
                for rep in range(1, 6):
                    usage = {'input_tokens': int(1000 * (factor if image == 'pr610' else 1)), 'cached_input_tokens': 0, 'output_tokens': 10}
                    rows.append({'image': image, 'task': task, 'rep': rep, 'usage': usage,
                                 'estimatedCredits': credits(usage), 'score': 1, 'success': success if image == 'pr610' else 1, 'status': 'ok'})
        return rows
    assert analyse(data(.9))['numericGatePassed']
    assert not analyse(data(.9, 0))['numericGatePassed']
    assert 'geometricMeanRatio' not in analyse(data()[:-1])
    bad = data(); bad[0]['usage'] = None
    assert not analyse(bad)['complete']
    bad = data(); bad[0]['status'] = 'infrastructure_error'
    assert not analyse(bad)['complete']
    bad = data(); bad[0]['estimatedCredits'] = 0
    assert not analyse(bad)['complete']
    try:
        analyse(data() + data()[:1])
        raise AssertionError('Duplicate accepted')
    except ValueError:
        pass
    result = analyse(data(1.6))
    assert len(result['outliersRequiringReview']) == 17
    assert result['categories']['survey']['disposition'] == 'remove override'
    assert result['categories']['fix']['disposition'] == 'investigate overhead'
    assert math.isclose(credits({'input_tokens': 1000000, 'cached_input_tokens': 1000000, 'output_tokens': 0}), 2.5)
    print('Codex report selftest: 11 gates passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', nargs='?')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        selftest()
    else:
        directory = Path(args.directory)
        rows = [json.loads(p.read_text(encoding='utf-8')) for p in directory.glob('*__r*/result.json') if '__probe-' not in p.parent.name]
        result = analyse(rows)
        (directory / 'summary.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({k: v for k, v in result.items() if k not in ['missing', 'perTask']}, indent=2))
