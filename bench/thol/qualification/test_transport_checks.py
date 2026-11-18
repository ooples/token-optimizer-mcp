import copy
import unittest

from transport_checks import compression_preserves_failure, ERROR_LINE


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.original = {'model': 'gpt-6.1-sol', 'reasoning': {'effort': 'high'}, 'input': [
            {'role': 'user', 'content': 'Fix ' + ERROR_LINE},
            {'type': 'function_call_output', 'call_id': 'call_log', 'output': 'noise\n' * 100 + ERROR_LINE}]}
        self.forwarded = copy.deepcopy(self.original)
        self.forwarded['input'][1]['output'] = ERROR_LINE

    def test_known_failure_survives_in_the_corresponding_tool_result(self):
        self.assertTrue(compression_preserves_failure(self.original, self.forwarded))

    def test_marker_in_user_prompt_cannot_substitute_for_dropped_error(self):
        self.forwarded['input'][1]['output'] = 'all tests passed'
        self.assertFalse(compression_preserves_failure(self.original, self.forwarded))

    def test_wrong_call_id_cannot_pass(self):
        self.forwarded['input'][1]['call_id'] = 'different'
        self.assertFalse(compression_preserves_failure(self.original, self.forwarded))

    def test_changed_model_or_reasoning_cannot_pass(self):
        self.forwarded['model'] = 'different'
        self.assertFalse(compression_preserves_failure(self.original, self.forwarded))

    def test_no_reduction_is_not_compression(self):
        self.assertFalse(compression_preserves_failure(self.original, self.original))
