"""Offline checks for the staging resource boundary."""
import pathlib
import subprocess
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name('ses.sh')


class StagingSesTests(unittest.TestCase):
    def load(self):
        source = SCRIPT.read_text().split("<<'PYTHON'\n", 1)[1].rsplit('\nPYTHON', 1)[0]
        scope = {'__name__': 'test'}
        exec(compile(source, str(SCRIPT), 'exec'), scope)
        return scope

    def test_wrong_caller_stops_before_mutations(self):
        scope = self.load()
        with patch.dict(scope, aws=lambda *a: {'Arn': 'arn:aws:iam::207570392857:root'}):
            with self.assertRaises(RuntimeError):
                scope['check_caller']()

    def test_dkim_changes_only_expected_cnames(self):
        scope = self.load()
        record = {'type': 'CNAME', 'name': 'abc._domainkey.mailstack-test.techskills.academy',
                  'content': 'abc.dkim.amazonses.com', 'proxied': False}
        scope['check_dns_delta']([], [record], [record], 'create')
        for changed in ({**record, 'name': 'production.techskills.academy'},
                        {**record, 'proxied': True}, {**record, 'content': 'other.example'}):
            with self.assertRaises(RuntimeError):
                scope['check_dns_delta']([], [changed], [record], 'create')

    def test_destination_order_does_not_trigger_update(self):
        scope = self.load()
        desired = {'Enabled': True, 'MatchingEventTypes': ['SEND', 'BOUNCE'],
                   'SnsDestination': {'TopicArn': scope['TOPIC_ARN']}}
        self.assertTrue(scope['destination_matches'](
            {**desired, 'Name': scope['TOPIC'], 'MatchingEventTypes': ['BOUNCE', 'SEND']}, desired))
        self.assertFalse(scope['destination_matches']({**desired, 'Enabled': False}, desired))
        self.assertFalse(scope['destination_matches'](None, desired))

    def test_nonexistent_resource_is_distinct_from_access_denied(self):
        scope = self.load()
        for error, expected in [('NotFoundException', None), ('AccessDeniedException', 'raise')]:
            with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 254, '', '(' + error + ')')):
                if expected == 'raise':
                    with self.assertRaises(RuntimeError):
                        scope['aws']('sesv2', 'get-email-identity', missing=True)
                else:
                    self.assertIsNone(scope['aws']('sesv2', 'get-email-identity', missing=True))


if __name__ == '__main__':
    unittest.main()
