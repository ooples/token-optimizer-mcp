"""Independent local transport fixture checks; never infer model quality."""
import json

ERROR_LINE = 'FAILED tests/test_sum.py::test_add - AssertionError: sentinel-481'


def compression_preserves_failure(original, forwarded):
    if forwarded.get('model') != original.get('model') or forwarded.get('reasoning') != original.get('reasoning'):
        return False
    outputs = [x.get('output', '') for x in forwarded.get('input', [])
               if isinstance(x, dict) and x.get('type') == 'function_call_output' and x.get('call_id') == 'call_log']
    return (any(isinstance(value, str) and ERROR_LINE in value for value in outputs) and
            len(json.dumps(forwarded).encode()) < len(json.dumps(original).encode()))
