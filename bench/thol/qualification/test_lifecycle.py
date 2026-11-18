import json
import hashlib
import io
from pathlib import Path
import tempfile
import tarfile
import unittest

from lifecycle import Lifecycle
from workspace_evidence import retain, verify_archive


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_setup_and_failed_costs_stay_counted(self):
        ledger = Lifecycle(self.root, 5)
        ledger.begin('setup', 'setup', 2)
        ledger.finish(2)
        ledger.begin('failed', 'agent', 3)
        ledger.finish(1, infrastructure_ok=False)
        result = json.loads(ledger.path.read_text())
        self.assertEqual(result['knownEstimatedCredits'], 3)
        self.assertEqual(result['state'], 'stopped')
        with self.assertRaises(RuntimeError):
            ledger.begin('another', 'agent', 1)

    def test_unknown_usage_is_never_zero(self):
        ledger = Lifecycle(self.root, 5)
        ledger.begin('attempt', 'agent', 1)
        ledger.finish(None)
        self.assertEqual(json.loads(ledger.path.read_text())['unknownUsageAttempts'], 1)
        with self.assertRaises(RuntimeError):
            ledger.complete(report_admitted=True)

    def test_interruption_blocks_restart(self):
        ledger = Lifecycle(self.root, 5)
        ledger.begin('attempt', 'agent', 1)
        resumed = Lifecycle(self.root, 5)
        self.assertEqual(resumed.state, 'stopped')
        with self.assertRaises(RuntimeError):
            resumed.begin('next', 'agent', 1)

    def test_reservation_and_limit_are_enforced_before_dispatch(self):
        ledger = Lifecycle(self.root, 5)
        ledger.begin('setup', 'setup', 3)
        ledger.finish(3)
        with self.assertRaises(RuntimeError):
            ledger.begin('too-large', 'agent', 3)
        self.assertEqual(len(ledger.attempts), 1)
        with self.assertRaises(ValueError):
            Lifecycle(self.root, 6)

    def test_overrun_is_recorded_then_stops(self):
        ledger = Lifecycle(self.root, 5)
        ledger.begin('attempt', 'agent', 1)
        ledger.finish(2)
        self.assertEqual(ledger.state, 'stopped')
        self.assertEqual(ledger.attempts[0]['credits'], 2)

    def test_completion_requires_admitted_report(self):
        ledger = Lifecycle(self.root, 5)
        ledger.begin('attempt', 'agent', 1)
        ledger.finish(1)
        with self.assertRaises(RuntimeError):
            ledger.complete(report_admitted=False)
        ledger.complete(report_admitted=True)
        self.assertEqual(ledger.state, 'complete')
        self.assertFalse(json.loads(ledger.path.read_text())['chatNotificationDelivered'])

    def test_retained_workspace_can_be_verified_and_tampering_detected(self):
        workspace = self.root / 'workspace'
        workspace.mkdir()
        (workspace / 'answer.py').write_text('answer = 42\n')
        evidence = self.root / 'evidence'
        receipt = retain(workspace, evidence)
        self.assertEqual(verify_archive(evidence), receipt)
        with (evidence / 'workspace.tar').open('ab') as stream:
            stream.write(b'tampered')
        with self.assertRaises(ValueError):
            verify_archive(evidence)

    def test_evidence_cannot_archive_itself(self):
        with self.assertRaises(ValueError):
            retain(self.root, self.root / 'evidence')

    def link_archive(self, links):
        destination = self.root / 'links'
        destination.mkdir()
        content = b'answer = 42\n'
        with tarfile.open(destination / 'workspace.tar', 'w') as archive:
            file = tarfile.TarInfo('lib/source.py')
            file.size = len(content)
            archive.addfile(file, io.BytesIO(content))
            for name, target in links.items():
                info = tarfile.TarInfo(name)
                info.type = tarfile.SYMTYPE
                info.linkname = target
                archive.addfile(info)
        receipt = {'archiveSha256': hashlib.sha256((destination / 'workspace.tar').read_bytes()).hexdigest(),
                   'files': {'lib/source.py': hashlib.sha256(content).hexdigest()}, 'links': links}
        (destination / 'workspace.json').write_text(json.dumps(receipt))
        return destination

    def test_relative_links_within_the_archived_project_are_supported(self):
        directory = self.link_archive({'alias.py': 'lib/source.py'})
        self.assertEqual(verify_archive(directory)['links']['alias.py'], 'lib/source.py')

    def test_chained_links_cannot_escape_the_archived_project(self):
        directory = self.link_archive({'alias': 'target', 'target': '../outside'})
        with self.assertRaisesRegex(ValueError, 'escapes'):
            verify_archive(directory)


if __name__ == '__main__':
    unittest.main()
