"""Strict entry point for re-reporting the frozen 610 campaign.

The historical reporter remains unchanged. No verdict is emitted unless the
independent evidence admission succeeds. New campaign designs need their own
frozen analysis, calling this same admission function before statistical work.
"""
import argparse
import importlib.util
import json
from pathlib import Path

from evidence_guard import read, validate


def report(rows, contract, evidence, hashes):
    admission = validate(rows, contract, evidence, hashes)
    if not admission['validated']:
        return {'admission': admission, 'complete': False}
    frozen = Path(__file__).resolve().parents[1] / 'campaigns/610-codex-board/report.py'
    spec = importlib.util.spec_from_file_location('frozen610report', frozen)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {'admission': admission, **module.analyse(rows)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['rows', 'contract', 'evidence', 'hashes', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    # Replace any prior verdict even when an input is unreadable or malformed.
    # A failed invocation must never leave a stale passing report at --output.
    try:
        result = report(read(args.rows), read(args.contract), args.evidence, read(args.hashes))
    except Exception as error:
        result = {'admission': {'validated': False, 'errors': [str(error)]}, 'complete': False}
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'admitted': result['admission']['validated'], 'complete': result['complete']}))
    raise SystemExit(0 if result['complete'] else 2)
