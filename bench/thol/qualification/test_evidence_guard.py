import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

from evidence_guard import validate
from guarded_report import report

ROOT = Path(__file__).resolve().parents[1]


class EvidenceAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='taskclass-evidence-test-')
        self.evidence = Path(self.temp.name)
        self.contract = json.loads((Path(__file__).parent / '610-evidence-contract.json').read_text())
        self.contract['repetitions'] = 1
        self.contract['arms'] = {'pr610': self.contract['arms']['pr610']}
        self.contract['tasks'] = {'code-bugfix-py': self.contract['tasks']['code-bugfix-py']}
        source = json.loads((ROOT / 'campaigns/610-codex-board/results-v1/runs.json').read_text())
        self.row = copy.deepcopy(next(r for r in source if r['image'] == 'pr610' and r['task'] == 'code-bugfix-py' and r['rep'] == 1))
        self.row['hooks'] = {'session-start.mjs': 1, 'prompt.mjs': 1, 'stop.mjs': 1}
        self.directory = self.evidence / 'pr610__code-bugfix-py__r1'
        self.directory.mkdir()
        self.hooks = [{'entry': entry, 'input': json.dumps({'model': self.contract['model'],
                       'session_id': self.row['taskEvents'][0]['s'], 'prompt': 'Fix the failing tests'}),
                       'exit_code': 0, 'stderr': '', 'stdout': ''} for entry in self.row['hooks']]
        self.events = [{'type': 'turn.completed', 'usage': self.row['usage']}]
        self.identity = {'model': self.contract['model'], 'client': self.contract['client'],
                         'effort': 'high', 'task': 'code-bugfix-py', 'rep': 1,
                         'product': {k: self.contract['arms']['pr610'][k] for k in ['head', 'tree']},
                         'promptSha256': hashlib.sha256(b'Fix the failing tests').hexdigest()}
        self.identity['product']['dirty'] = False

    def tearDown(self):
        self.temp.cleanup()

    def run_case(self, duplicate=False, corrupt_hash=False):
        def save(name, value):
            (self.directory / name).write_text(json.dumps(value), encoding='utf-8')
        save('identity.json', self.identity)
        save('result.json', self.row)
        save('hook-state.json', {'state': {'taskClass': {'category': 'fix'}}})
        for name, values in [('hooks.jsonl', self.hooks), ('stdout.jsonl', self.events)]:
            (self.directory / name).write_text('\n'.join(json.dumps(v) for v in values), encoding='utf-8')
        digest = hashlib.sha256((self.directory / 'result.json').read_bytes()).hexdigest()
        hashes = {self.directory.name: 'bad' if corrupt_hash else digest}
        rows = [self.row, self.row] if duplicate else [self.row]
        return validate(rows, self.contract, self.evidence, hashes)

    def assert_rejected(self, fragment, **options):
        result = self.run_case(**options)
        self.assertFalse(result['validated'])
        self.assertTrue(any(fragment in e for e in result['errors']), result)

    def test_complete_receipts_are_accepted(self):
        self.assertTrue(self.run_case()['validated'])

    def test_missing_hook_counters_are_rejected(self):
        self.row['hooks'] = {}
        self.assert_rejected('missing recorded hook evidence')

    def test_missing_settings_are_rejected(self):
        self.row['selectedSettings'] = []
        self.assert_rejected('selected settings')

    def test_missing_classification_is_rejected(self):
        self.row['taskEvents'] = []
        self.assert_rejected('prompt classification')

    def test_impossible_scores_and_booleans_are_rejected(self):
        for score in [99, -1, float('nan'), float('inf'), True]:
            with self.subTest(score=score):
                self.row['score'] = score
                self.assert_rejected('score outside')

    def test_success_is_derived_from_frozen_threshold(self):
        self.row['success'] = 0
        self.assert_rejected('success inconsistent')

    def test_legitimate_partial_score_uses_its_task_threshold(self):
        self.row['score'] = .9
        self.contract['tasks']['code-bugfix-py']['successThreshold'] = .8
        self.assertTrue(self.run_case()['validated'])

    def test_configured_model_is_not_a_substitute_for_live_receipt(self):
        self.hooks[0]['input'] = json.dumps({'model': 'different-model'})
        self.assert_rejected('live model receipt')

    def test_bad_source_identity_is_rejected(self):
        self.identity['product']['tree'] = 'different-tree'
        self.assert_rejected('provenance mismatch')

    def test_raw_usage_must_match_record(self):
        self.events = [{'type': 'turn.completed', 'usage': dict(self.row['usage'], output_tokens=1)}]
        self.assert_rejected('usage does not reconcile')

    def test_no_usage_is_not_a_free_run(self):
        self.events = []
        self.assert_rejected('missing completed usage')

    def test_stale_artifact_hash_is_rejected(self):
        self.assert_rejected('artifact hash mismatch', corrupt_hash=True)

    def test_duplicate_run_is_rejected(self):
        self.assert_rejected('duplicate', duplicate=True)

    def test_prompt_mutation_is_rejected(self):
        self.identity['promptSha256'] = 'different-prompt'
        self.assert_rejected('prompt hash mismatch')

    def test_failed_hooks_are_rejected(self):
        self.hooks[0]['exit_code'] = 1
        self.assert_rejected('native hook execution failure')

    def test_rejected_evidence_never_reaches_statistical_report(self):
        self.row['score'] = 99
        self.run_case()
        digest = hashlib.sha256((self.directory / 'result.json').read_bytes()).hexdigest()
        result = report([self.row], self.contract, self.evidence, {self.directory.name: digest})
        self.assertFalse(result['complete'])
        self.assertNotIn('numericGatePassed', result)
        self.assertNotIn('geometricMeanRatio', result)

    def test_omitting_original_fields_is_rejected(self):
        self.run_case()
        digest = hashlib.sha256((self.directory / 'result.json').read_bytes()).hexdigest()
        published = dict(self.row)
        published.pop('agentSeconds')
        result = validate([published], self.contract, self.evidence, {self.directory.name: digest})
        self.assertTrue(any('differs from original' in e for e in result['errors']))

    def test_malformed_identity_is_rejected(self):
        result = validate([{'image': [], 'task': 'bad', 'rep': 1}], self.contract, self.evidence, {})
        self.assertFalse(result['validated'])

    def test_unreadable_input_replaces_stale_passing_report(self):
        output = self.evidence / 'stale.json'
        output.write_text('{"complete":true,"numericGatePassed":true}')
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('guarded_report.py')),
                                 '--rows', str(self.evidence / 'missing.json'),
                                 '--contract', str(Path(__file__).with_name('610-evidence-contract.json')),
                                 '--evidence', str(self.evidence), '--hashes', str(self.evidence / 'missing.json'),
                                 '--output', str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        record = json.loads(output.read_text())
        self.assertFalse(record['complete'])
        self.assertNotIn('numericGatePassed', record)


if __name__ == '__main__':
    unittest.main()
