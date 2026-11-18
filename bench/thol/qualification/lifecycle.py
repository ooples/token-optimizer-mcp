"""Fail-closed accounting primitives for a future runner; no paid entry point.

Every setup/agent/grading attempt is journaled before dispatch. Unknown usage,
infrastructure failure, overrun, or interrupted attempts prevents further work.
Local status files are evidence, not a claim of delivered chat notifications.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path


def nonnegative(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


class Lifecycle:
    def __init__(self, directory, limit):
        if not nonnegative(limit):
            raise ValueError('Invalid exposure limit')
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'lifecycle.json'
        self.limit = limit
        self.attempts = []
        self.state = 'ready'
        self.active = None
        if self.path.exists():
            old = json.loads(self.path.read_text())
            self.attempts = old['attempts']
            self.active = old['active']
            self.state = old['state']
            if old['limit'] != limit:
                raise ValueError('Exposure limit changed; requires a new reviewed campaign')
            if self.active is not None:
                self.state = 'stopped'
                self.save('Interrupted attempt has unknown exposure; reconcile before a new campaign')
        else:
            self.save('Created; no work dispatched')

    def save(self, message):
        status = {'state': self.state, 'active': self.active, 'limit': self.limit,
                  'attempts': self.attempts, 'updatedUTC': datetime.now(timezone.utc).isoformat(),
                  'knownEstimatedCredits': sum(a['credits'] for a in self.attempts if nonnegative(a.get('credits'))),
                  'unknownUsageAttempts': sum(a.get('credits') is None for a in self.attempts),
                  'message': message, 'chatNotificationDelivered': False}
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(status, indent=2) + '\n', encoding='utf-8')
        temporary.replace(self.path)
        with (self.directory / 'milestones.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({k: v for k, v in status.items() if k != 'attempts'}) + '\n')

    def begin(self, key, phase, reservation):
        if self.state not in ['ready', 'running'] or self.active is not None:
            raise RuntimeError('Campaign is not dispatchable')
        if phase not in ['setup', 'agent', 'grading'] or not nonnegative(reservation):
            raise ValueError('A valid phase and conservative exposure reservation are required')
        if any(a['key'] == key for a in self.attempts):
            raise ValueError('Duplicate attempt; retain failures and use a new reviewed identity')
        spent = sum(a['credits'] for a in self.attempts)
        if spent + reservation > self.limit:
            self.state = 'stopped'
            self.save('Exposure reservation exceeds remaining budget')
            raise RuntimeError('Exposure cap reached')
        self.active = {'key': key, 'phase': phase, 'reservation': reservation, 'credits': None}
        self.attempts.append(self.active)
        self.state = 'running'
        self.save('Dispatch recorded before execution')

    def finish(self, credits, *, infrastructure_ok=True):
        if self.active is None or self.state != 'running':
            raise RuntimeError('No running attempt')
        known = nonnegative(credits)
        self.active['credits'] = credits if known else None
        self.active['infrastructureOK'] = bool(infrastructure_ok)
        overrun = known and credits > self.active['reservation']
        self.active = None
        if not known or not infrastructure_ok or overrun:
            self.state = 'stopped'
            self.save('Unknown usage, infrastructure failure, or reservation overrun; further dispatch blocked')
        else:
            self.save('Attempt completed; all setup and failed-attempt costs remain in ledger')

    def stop(self, reason):
        self.state = 'stopped'
        self.save(reason)

    def complete(self, *, report_admitted):
        if self.state != 'running' or self.active is not None or not report_admitted:
            raise RuntimeError('Completion requires no pending attempt and an admitted report')
        self.state = 'complete'
        self.save('Terminal report admitted')
