"""Verify BCa implementation against SciPy and fail-closed decision behavior."""
import importlib.util
import json
import tempfile
from pathlib import Path
import numpy as np
from scipy.stats import bootstrap

spec=importlib.util.spec_from_file_location('analysis',Path(__file__).with_name('confirmation-analyze.py'))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
g=np.array([[10+i*i*.31,20+i*.73] for i in range(12)])
actual=module.intervals([g],2000,77)
for key,stat in [('geometricPairedCost',lambda x,y:np.exp(np.mean(np.log(x/y)))),('equalFamilyDollarCost',lambda x,y:np.mean(x)/np.mean(y))]:
    expected=bootstrap((g[:,0],g[:,1]),stat,paired=True,vectorized=False,n_resamples=2000,method='BCa',rng=np.random.default_rng(77)).confidence_interval
    np.testing.assert_allclose(actual[key]['ci95Ratio'],[expected.low,expected.high],rtol=1e-10)

with tempfile.TemporaryDirectory(prefix='confirmation-stat-check-') as name:
    root=Path(name)
    plan={'pairs':70,'pairsPerFamily':10,'families':[str(i) for i in range(7)],'model':'test','caseSuite':'heldout-v1','scenario':{'usdPerMillion':{'uncached':10,'cached':1,'output':50}},'bootstrap':{'resamples':1000,'seed':17},'success':{'minimumOneSided95SuccessBound':.95,'bothCostUpper95Below':.95},'schedule':[]}
    for family in plan['families']:
        for i in range(10):
            case={'id':f'{family}-{i}','family':family,'task':'refresh','seed':100+i,'readMode':'natural','arms':['proxy','headroom']}
            plan['schedule'].append(case)
            folder=root/'cases'/case['id'];folder.mkdir(parents=True)
            (folder/'manifest.json').write_text(json.dumps({'model':'test','caseSuite':'heldout-v1','readMode':'natural','arms':case['arms'],'seedOffset':case['seed']-1,'tasks':['refresh'],'reps':1}))
            rows=[]
            for arm in case['arms']:
                tokens=5000+i*13 if arm=='proxy' else 10000+i*17
                rows.append({'arm':arm,'task':'refresh','seed':case['seed'],'rep':1,'usage':{'input':tokens,'cached':0,'output':100},'ledgerUsage':[{'status':200,'usage':{'input_tokens':tokens,'cached_input_tokens':0,'output_tokens':100}}],'requests':1,'agentSeconds':1,'seconds':2})
            (folder/'results.json').write_text(json.dumps(rows))
            (folder/'validation.json').write_text(json.dumps([{'arm':a,'verdict':'PASS'} for a in case['arms']]))
    (root/'plan.json').write_text(json.dumps(plan))
    (root/'execution.json').write_text(json.dumps({'status':'complete','pairs':plan['schedule']}))
    assert module.analyze(root)['superiorityEstablished']
    first=root/'cases'/'0-0'/'validation.json'
    # Missing competitor cost must block inference without erasing our success.
    result_file = root/'cases'/'0-0'/'results.json'
    saved_rows = json.loads(result_file.read_text())
    failed_rows = json.loads(result_file.read_text())
    failed_rows[1]['ledgerUsage'].append({'status':503,'usage':{}})
    failed_rows[1]['usage'] = None
    failed_rows[1]['clientErrors'] = ['unexpected status 503']
    result_file.write_text(json.dumps(failed_rows))
    first.write_text(json.dumps([{'arm':'proxy','verdict':'PASS'},{'arm':'headroom','verdict':'FAIL','clientErrors':['unexpected status 503']}]))
    incomplete = module.analyze(root)
    assert not incomplete['superiorityEstablished']
    assert incomplete['proxyPasses'] == 70 and incomplete['headroomPasses'] == 69
    assert len(incomplete['attempts']) == 140 and incomplete['pairsMeasured'] == 69
    failed = next(a for a in incomplete['attempts'] if a['case']=='0-0' and a['arm']=='headroom')
    assert failed['knownEstimatedUsd'] > 0 and failed['totalEstimatedUsd'] is None
    assert failed['unknownUsageRequests'] == [{'request':2,'status':503}]
    assert incomplete['attemptAccounting']['headroom']['unknownCostAttempts'] == 1
    result_file.write_text(json.dumps(saved_rows))
    first.write_text(json.dumps([{'arm':'proxy','verdict':'FAIL'},{'arm':'headroom','verdict':'PASS'}]))
    assert not module.analyze(root)['superiorityEstablished']
    first.unlink()
    assert not module.analyze(root)['superiorityEstablished']
print('BCa matches SciPy; success, failed quality, and missing evidence gates checked.')
