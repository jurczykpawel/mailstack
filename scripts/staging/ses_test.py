"""Offline checks for the staging resource boundary."""
import pathlib
import os
import subprocess
import unittest
import tempfile
import json
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name('ses.sh')


class StagingSesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = {'MAILSTACK_STAGING_ACCOUNT_ID': 'test-account', 'MAILSTACK_PRODUCTION_ACCOUNT_ID': 'prod-account', 'MAILSTACK_STAGING_TOKEN_ITEM': 'staging-token-fixture', 'MAILSTACK_PRODUCTION_TOKEN_ITEM': 'production-token-fixture', 'MAILSTACK_PRODUCTION_HEALTH_URL': 'https://production.example.com/health', 'MAILSTACK_STAGING_HOST': 'staging.example.com', 'MAILSTACK_STAGING_LICENSE_HOST': 'license.staging.example.com', 'MAILSTACK_STAGING_INTERNAL_HOST': 'internal.staging.example.com', 'MAILSTACK_STAGING_ZONE': 'example.com', 'MAILSTACK_STAGING_AWS_ACCOUNT_ID': '123456789012', 'MAILSTACK_STAGING_SES_REGION': 'eu-west-1', 'MAILSTACK_STAGING_SES_DOMAIN': 'staging.example.com', 'MAILSTACK_STAGING_FROM': 'no-reply@staging.example.com', 'MAILSTACK_STAGING_SES_CONFIGURATION_SET': 'mailstack-staging', 'MAILSTACK_STAGING_EVENTS_URL': 'https://mailstack-staging.fixture.workers.dev/v1/events/ses', 'MAILSTACK_STAGING_AWS_PROFILE': 'fixture', 'MAILSTACK_STAGING_AWS_CALLER_ARN': 'arn:aws:iam::123456789012:user/staging-operator', 'MAILSTACK_STAGING_B2_BUCKET': 'staging-backup-fixture', 'MAILSTACK_STAGING_B2_ENDPOINT': 'https://s3.eu-central-003.backblazeb2.com', 'MAILSTACK_STAGING_NODE_HOST': 'staging-host', 'MAILSTACK_STAGING_NODE_STACK': '/opt/stacks/mailstack-staging', 'MAILSTACK_STAGING_NODE_URL': 'https://node.staging.example.com', 'HOME': '/nonexistent-mailstack-staging-fixture'}
        self.environment = patch.dict(os.environ, self.fixture, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def load(self):
        source = SCRIPT.read_text().split("<<'PYTHON'\n", 1)[1].rsplit('\nPYTHON', 1)[0]
        scope = {'__name__': 'test'}
        exec(compile(source, str(SCRIPT), 'exec'), scope)
        return scope

    def test_private_operator_file_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'operator.json'
            path.write_text(json.dumps({k: v for k, v in self.fixture.items() if k.startswith('MAILSTACK_')}))
            path.chmod(0o600)
            with patch.dict(os.environ, {'MAILSTACK_STAGING_OPERATOR': str(path),
                                       'MAILSTACK_STAGING_EVENTS_URL': 'https://override.example/v1/events/ses'}, clear=True):
                self.assertEqual(self.load()['ENDPOINT'], 'https://override.example/v1/events/ses')
                path.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, 'readable 0600 JSON'):
                    self.load()

    def test_missing_configuration_fails_without_provider_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {'HOME': directory}, clear=True), patch('subprocess.run') as run:
                with self.assertRaisesRegex(RuntimeError, 'MAILSTACK_STAGING_AWS_ACCOUNT_ID'):
                    self.load()
                run.assert_not_called()

    def test_worker_events_use_staging_while_dns_guard_uses_production(self):
        with patch.dict(os.environ, self.fixture, clear=True):
            scope = self.load()
            self.assertEqual(scope['ENDPOINT'], 'https://mailstack-staging.fixture.workers.dev/v1/events/ses')
            self.assertEqual(scope['CF_ACCOUNT'], 'prod-account')
            self.assertEqual(scope['CONFIG'], 'mailstack-staging')
            self.assertEqual(scope['TOPIC'], 'mailstack-staging-events')
        with patch.dict(os.environ, {'MAILSTACK_STAGING_EVENTS_URL': 'https://other.example/v1/events/ses', 'MAILSTACK_PRODUCTION_ACCOUNT_ID': 'production-fixture'}):
            scope = self.load()
            self.assertEqual(scope['ENDPOINT'], 'https://other.example/v1/events/ses')
            self.assertEqual(scope['CF_ACCOUNT'], 'production-fixture')

    def test_wrong_caller_stops_before_mutations(self):
        scope = self.load()
        with patch.dict(scope, aws=lambda *a: {'Arn': 'arn:aws:iam::123456789012:root'}):
            with self.assertRaises(RuntimeError):
                scope['check_caller']()

    def test_dkim_changes_only_expected_cnames(self):
        scope = self.load()
        record = {'type': 'CNAME', 'name': 'abc._domainkey.staging.example.com',
                  'content': 'abc.dkim.amazonses.com', 'proxied': False}
        scope['check_dns_delta']([], [record], [record], 'create')
        for changed in ({**record, 'name': 'production.example.com'},
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
