"""Simultaneous per-family bounds; failures and ties remain in the denominator."""
import json
import math
import sys
from pathlib import Path
import numpy as np
from scipy.stats import beta, t


def bounds(pairs, metric, alpha):
    values = []
    for pair in pairs:
        p, h = (pair['arms'][a][metric] for a in ['proxy', 'headroom'])
        if not isinstance(p, (int, float)) or not isinstance(h, (int, float)) or not math.isfinite(p) or not math.isfinite(h) or p <= 0 or h <= 0:
            return {'upperRatio': None, 'reason': 'Incomplete or nonpositive measurement'}
        values.append(math.log(p / h))
    if len(values) < 2:
        return {'upperRatio': None, 'reason': 'Insufficient pairs'}
    mean = float(np.mean(values))
    se = float(np.std(values, ddof=1) / math.sqrt(len(values)))
    upper = math.exp(mean + t.ppf(1-alpha, len(values)-1) * se)
    return {'geometricRatio': math.exp(mean), 'upperRatio': upper, 'alpha': alpha, 'degenerate': se == 0}


def analyze(plan, audit):
    alpha = plan['joint']['alpha'] / (len(plan['families']) * plan['joint']['comparisonsPerFamily'])
    families = {}
    expected = {c['id']: c for c in plan['schedule']}
    actual = {c['id']: c for c in audit['cases']}
    complete = len(actual) == len(audit['cases']) == len(expected) and set(actual) == set(expected)
    for family in plan['families']:
        group = [r for r in audit['cases'] if r['family'] == family]
        wins = sum(r['classification'] == 'joint-win' for r in group)
        n = sum(c['family'] == family for c in plan['schedule'])
        lower = float(beta.ppf(alpha, wins, n-wins+1)) if wins else 0
        cost = bounds(group, 'estimatedUsd', alpha)
        speed = bounds(group, 'agentSeconds', alpha)
        valid = len(group) == n and all(r['arms'][a]['verdict'] == 'PASS' for r in group for a in ['proxy', 'headroom'])
        passed = valid and all(v['upperRatio'] is not None and v['upperRatio'] < 1 and not v.get('degenerate') for v in [cost, speed]) and lower > plan['joint']['minimumFamilyJointWinProbability']
        families[family] = {'planned': n, 'jointWins': wins, 'jointWinProbabilityLower': lower, 'cost': cost, 'speed': speed, 'qualified': passed}
    return {'complete': complete, 'simultaneousConfidence': 1-plan['joint']['alpha'], 'families': families,
            'everyObservedTaskJointWin': complete and all(r['classification'] == 'joint-win' for r in audit['cases']),
            'allFamiliesQualified': complete and all(f['qualified'] for f in families.values()),
            'universalSuperiorityEstablished': False,
            'scope': 'Family mean bounds and sampled joint-win probability; no finite suite establishes every future task or execution. Inference assumes independent pairs and approximate normality of log ratios. Failures are never removed to qualify a family.'}


if __name__ == '__main__':
    root = Path(sys.argv[1])
    result = analyze(json.loads((root/'plan.json').read_text()), json.loads((root/'joint-audit.json').read_text()))
    with (root/'joint-analysis.json').open('x') as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
