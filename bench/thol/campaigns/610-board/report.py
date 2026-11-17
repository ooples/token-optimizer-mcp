"""Summarise the pre-registered board; incomplete batteries get no headline."""
import argparse
import json
import math
from pathlib import Path
import statistics
import subprocess

GROUPS = {
    'fix': ['code-bugfix-py', 'code-iterate-tests', 'code-debug-pipeline-py', 'code-debug-ledger-py', 'code-debug-cascade-py'],
    'build': ['code-feature-js', 'code-feature-validate-py', 'code-migration-py', 'code-migration-py-xl', 'code-refactor-split-py'],
    'survey': ['code-comprehension-django', 'code-overview-cobra', 'code-settings-inventory-django', 'report-pdf', 'seo-audit'],
    'locate': ['log-needle-zh'],
    'rewrite': ['code-rewrite-modernize-py'],
}
TASKS = {t for tasks in GROUPS.values() for t in tasks}
REPS = 5


def fetch(image):
    script = '''import json,sqlite3
from pathlib import Path
p=Path('/results/results.sqlite')
if not p.exists(): print('[]'); raise SystemExit(0)
c=sqlite3.connect('file:/results/results.sqlite?mode=ro',uri=True)
c.row_factory=sqlite3.Row
if not c.execute("select 1 from sqlite_master where type='table' and name='runs'").fetchone(): print('[]'); raise SystemExit(0)
rows=c.execute('select run_id,competitor,task,rep,status,score,success,total_cost_usd,num_turns,output_tokens,input_tokens,wall_ms from runs').fetchall()
print(json.dumps([dict(r) for r in rows]))'''
    result = subprocess.run(['docker', 'run', '--rm', '-v', f'thol-610-board-v2-{image}:/results:ro', '--entrypoint',
                             'python3', f'thol-rig:{image}', '-c', script], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def analyse(data):
    result = {'complete': False, 'runs': {}, 'spent_usd': 0, 'per_task': {}, 'categories': {}, 'outliers': [], 'missing': []}
    indexed = {}
    for image in ['pr610', 'master']:
        rows = data[image]
        result['runs'][image] = len(rows)
        result['spent_usd'] += sum(r.get('total_cost_usd') or 0 for r in rows)
        selected = {}
        for r in rows:
            if r['competitor'] != 'token-optimizer-mcp' or r['task'] not in TASKS or not 1 <= r['rep'] <= REPS:
                raise ValueError('Unexpected arm/task/repetition in this dedicated campaign')
            key = (r['task'], r['rep'])
            if key in selected:
                raise ValueError('Duplicate task/repetition; do not silently select a favourable run')
            selected[key] = r
        indexed[image] = selected
        result['missing'].extend(f'{image}:{t}:r{rep}' for t in sorted(TASKS) for rep in range(1, REPS + 1) if (t, rep) not in selected)
    for task in sorted(TASKS):
        pair = {}
        for image in indexed:
            rows = [indexed[image][(task, rep)] for rep in range(1, REPS + 1) if (task, rep) in indexed[image]]
            costs = [r['total_cost_usd'] for r in rows if r.get('total_cost_usd') is not None]
            pair[image] = {'runs': len(rows), 'median_usd': statistics.median(costs) if costs else None,
                           'successes': sum(r.get('success') == 1 for r in rows),
                           'statuses': {s: sum(r['status'] == s for r in rows) for s in sorted({r['status'] for r in rows})}}
        if all(p['runs'] == REPS and p['median_usd'] is not None and p['median_usd'] > 0 for p in pair.values()):
            pair['ratio'] = pair['pr610']['median_usd'] / pair['master']['median_usd']
            if pair['ratio'] < 0.67 or pair['ratio'] > 1.5:
                result['outliers'].append(task)
        result['per_task'][task] = pair
    # Do not average a partial battery or a task with incomplete billing.
    valid_costs = all(r.get('total_cost_usd') is not None and r['total_cost_usd'] >= 0 for rows in data.values() for r in rows)
    if result['missing'] or not valid_costs or any('ratio' not in p for p in result['per_task'].values()):
        return result
    result['complete'] = True
    for category, tasks in GROUPS.items():
        ratio = math.exp(statistics.mean(math.log(result['per_task'][t]['ratio']) for t in tasks))
        threshold = 1.03 if category in ['survey', 'rewrite'] else 1.05
        result['categories'][category] = {'ratio': ratio, 'threshold': threshold, 'action':
            ('remove override' if category in ['survey', 'rewrite'] else 'investigate overhead') if ratio > threshold else 'within threshold'}
    result['task_mean_ratio'] = math.exp(statistics.mean(math.log(p['ratio']) for p in result['per_task'].values()))
    result['successes'] = {image: sum(p[image]['successes'] for p in result['per_task'].values()) for image in indexed}
    result['numeric_ship_gate'] = result['task_mean_ratio'] <= 1 and result['successes']['pr610'] >= result['successes']['master']
    result['outlier_review_required'] = bool(result['outliers'])
    return result


def selftest():
    def data(cost=1, success=1):
        return {image: [dict(run_id=f'{image}-{t}-{rep}', competitor='token-optimizer-mcp', task=t, rep=rep,
                            status='ok', success=success if image == 'pr610' else 1, total_cost_usd=cost if image == 'pr610' else 1)
                       for t in TASKS for rep in range(1, REPS + 1)] for image in ['pr610', 'master']}
    assert analyse(data(.9))['numeric_ship_gate']
    assert not analyse(data(.9, 0))['numeric_ship_gate']
    partial = data(.9); partial['pr610'].pop()
    assert 'task_mean_ratio' not in analyse(partial)
    missing_cost = data(.9); missing_cost['pr610'][0]['total_cost_usd'] = None
    assert 'task_mean_ratio' not in analyse(missing_cost)
    duplicate = data(.9); duplicate['pr610'].append(duplicate['pr610'][0])
    try:
        analyse(duplicate)
        raise AssertionError('duplicate accepted')
    except ValueError:
        pass
    regressed = data(1.1)
    assert analyse(regressed)['categories']['survey']['action'] == 'remove override'
    assert analyse(regressed)['categories']['fix']['action'] == 'investigate overhead'
    assert len(analyse(data(1.6))['outliers']) == len(TASKS)
    print('report selftest: 8 gates passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--selftest', action='store_true')
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        selftest()
    else:
        data = {image: fetch(image) for image in ['pr610', 'master']}
        result = analyse(data)
        if args.write:
            target = Path(__file__).parent
            (target / 'runs.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
            (target / 'summary.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, indent=2))
