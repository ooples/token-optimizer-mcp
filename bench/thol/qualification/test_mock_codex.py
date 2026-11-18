import json
import unittest

from mock_codex import verify_smoke


class SmokeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.events = [{'type': 'item.completed', 'item': {'type': 'command_execution', 'exit_code': 0,
                       'aggregated_output': 'def add(a, b):\n    return a + b\n'}}, {'type': 'turn.completed'}]
        self.output = {'exit_code': 0, 'requests': [{'model': 'gpt-6.1-sol', 'reasoning': {'effort': 'high'}}] * 2}

    def verify(self):
        return verify_smoke(dict(self.output, stdout='\n'.join(json.dumps(e) for e in self.events)))

    def test_complete_known_answer_and_same_model_are_required(self):
        self.assertTrue(self.verify())
        self.output['requests'] = [{'model': 'different', 'reasoning': {'effort': 'high'}}] * 2
        self.assertFalse(self.verify())

    def test_exit_zero_without_executed_tool_is_insufficient(self):
        self.events = self.events[1:]
        self.assertFalse(self.verify())

    def test_blocked_or_failed_tool_cannot_pass(self):
        self.events[0]['item']['exit_code'] = 1
        self.assertFalse(self.verify())

    def test_missing_known_source_cannot_pass(self):
        self.events[0]['item']['aggregated_output'] = 'completed successfully'
        self.assertFalse(self.verify())

    def test_failed_or_unfinished_turn_cannot_pass(self):
        self.events = self.events[:1]
        self.assertFalse(self.verify())
        self.events += [{'type': 'turn.completed'}, {'type': 'turn.failed'}]
        self.assertFalse(self.verify())


if __name__ == '__main__':
    unittest.main()
