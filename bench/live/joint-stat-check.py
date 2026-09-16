"""Adversarial checks for missing measurements, quality failures and multiplicity."""
import importlib.util
from pathlib import Path
from copy import deepcopy
from scipy.stats import beta

spec = importlib.util.spec_from_file_location('joint', Path(__file__).with_name('joint-analyze.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
plan = {'families': ['a', 'b'], 'joint': {'alpha': .05, 'comparisonsPerFamily': 3, 'minimumFamilyJointWinProbability': .5}, 'schedule': [{'id': f'{f}-{i}', 'family': f} for f in ['a', 'b'] for i in range(10)]}
audit = {'cases': [{**c, 'classification': 'joint-win', 'arms': {'proxy': {'estimatedUsd': .4+i*.001, 'agentSeconds': 1+i*.001, 'verdict': 'PASS'}, 'headroom': {'estimatedUsd': 2, 'agentSeconds': 4, 'verdict': 'PASS'}}} for i,c in enumerate(plan['schedule'])]}
result = module.analyze(plan, audit)
assert result['allFamiliesQualified'] and result['everyObservedTaskJointWin']
assert result['families']['a']['jointWinProbabilityLower'] == beta.ppf(.05/6, 10, 1)
assert not result['universalSuperiorityEstablished']
for key, value in [('estimatedUsd', None), ('agentSeconds', float('nan')), ('verdict', 'FAIL')]:
    damaged = deepcopy(audit)
    damaged['cases'][0]['arms']['proxy'][key] = value
    damaged['cases'][0]['classification'] = 'unknown' if key != 'verdict' else 'quality-failure'
    checked = module.analyze(plan, damaged)
    assert not checked['allFamiliesQualified'] and not checked['everyObservedTaskJointWin']
damaged = deepcopy(audit)
damaged['cases'].pop()
assert not module.analyze(plan, damaged)['complete']
damaged = deepcopy(audit)
damaged['cases'].append(damaged['cases'][0])
assert not module.analyze(plan, damaged)['complete']
print('Joint inference: simultaneous bounds, incomplete/duplicate data, quality and unknown usage gates passed.')
