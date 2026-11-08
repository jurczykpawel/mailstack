#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PYTHON'
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

ACCOUNT = '207570392857'
REGION = 'eu-west-1'
DOMAIN = 'mailstack-test.techskills.academy'
CONFIG = os.environ.get('MAILSTACK_STAGING_SES_CONFIGURATION_SET', 'mailstack-staging-f3')
TOPIC = f'{CONFIG}-events'
TOPIC_ARN = f'arn:aws:sns:{REGION}:{ACCOUNT}:{TOPIC}'
CONFIG_ARN = f'arn:aws:ses:{REGION}:{ACCOUNT}:configuration-set/{CONFIG}'
ENDPOINT = os.environ.get('MAILSTACK_STAGING_EVENTS_URL',
                          'https://mailstack-staging.pavveldev.workers.dev/v1/events/ses')
CF_ACCOUNT = os.environ.get('MAILSTACK_PRODUCTION_ACCOUNT_ID', '92e7018cfc666807c755836278d19eaf')


def aws(*args, missing=False):
    result = subprocess.run(['aws', '--profile', 'default', '--region', REGION,
                             '--output', 'json', '--no-cli-pager', *args],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        if missing and any(f'({code})' in result.stderr for code in
                           ('NotFoundException', 'NotFound', 'NoSuchEntity')):
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def check_caller():
    if aws('sts', 'get-caller-identity').get('Arn') != f'arn:aws:iam::{ACCOUNT}:user/pavvel-cli':
        raise RuntimeError('Expected default profile to be IAM user pavvel-cli')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def check_dns_delta(before, after, expected, command):
    fields = ('type', 'name', 'content', 'proxied')
    project = lambda r: canonical({k: r.get(k) for k in fields})
    allowed = {project(r) for r in expected}
    old, new = {canonical(r): r for r in before}, {canonical(r): r for r in after}
    removed = [old[k] for k in old.keys() - new.keys()]
    added = [new[k] for k in new.keys() - old.keys()]
    if command == 'create':
        valid = not removed and all(project(r) in allowed for r in added)
    else:
        valid = not added and all(project(r) in allowed for r in removed)
    if not valid:
        raise RuntimeError('DNS difference includes changes outside expected staging DKIM records')
    return {'added': added, 'removed': removed}


def destination_matches(existing, desired):
    return existing is not None and all(
        sorted(existing.get(k, [])) == sorted(v) if k == 'MatchingEventTypes'
        else existing.get(k) == v for k, v in desired.items())


class Cloudflare:
    def __init__(self):
        result = subprocess.run(['bw', 'get', 'password', 'CF Deploy - General API token'],
                                capture_output=True, text=True, timeout=60)
        if result.returncode or not result.stdout.strip():
            raise RuntimeError('Agent Vaultwarden Cloudflare token unavailable')
        self.token = result.stdout.strip()
        zones = self.list('/zones?name=techskills.academy')
        if len(zones) != 1:
            raise RuntimeError('Expected exactly one techskills.academy zone')
        self.path = f"/zones/{zones[0]['id']}/dns_records"

    def request(self, path, method='GET', body=None):
        req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path,
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)
        if not data.get('success'):
            raise RuntimeError('Cloudflare request failed: ' + canonical(data.get('errors')))
        return data

    def list(self, path):
        rows, page = [], 1
        while True:
            data = self.request(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
            rows.extend(data['result'])
            if page >= data.get('result_info', {}).get('total_pages', 1):
                return rows
            page += 1

    def fingerprint(self):
        return self.request(f'/accounts/{CF_ACCOUNT}/workers/scripts/mailstack/deployments')['result']


def inventory():
    identities = aws('sesv2', 'list-email-identities').get('EmailIdentities', [])
    configs = aws('sesv2', 'list-configuration-sets').get('ConfigurationSets', [])
    topics = aws('sns', 'list-topics').get('Topics', [])
    try:
        users = aws('iam', 'list-users').get('Users', [])
    except RuntimeError as error:
        if 'AccessDenied' not in str(error):
            raise
        users = {'unavailable': str(error)}
    return {'identities': sorted((i for i in identities if i['IdentityName'] != DOMAIN), key=canonical),
            'configurationSets': sorted(c for c in configs if c != CONFIG),
            'topics': sorted((t for t in topics if t['TopicArn'] != TOPIC_ARN), key=canonical),
            'iamUsers': users}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('status', 'create', 'destroy'):
        raise RuntimeError('Usage: scripts/staging/ses.sh status|create|destroy')
    command = sys.argv[1]
    os.umask(0o077)
    check_caller()
    cf = Cloudflare()
    state = pathlib.Path(os.environ.get('MAILSTACK_SES_STATE',
                         str(pathlib.Path.home() / '.local/state/mailstack-staging-ses')))
    run = state / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    run.mkdir(parents=True, mode=0o700)
    def save(name, data):
        (run / (name + '.json')).write_text(json.dumps(data, indent=2) + '\n')
    before = inventory()
    dns_before = cf.list(cf.path)
    worker_before = cf.fingerprint()
    save('production-before', before)
    save('dns-before', dns_before)
    save('worker-before', worker_before)
    expected = []
    try:
        account = aws('sesv2', 'get-account')
        save('account', account)
        print('AWS SES sandbox:', not account.get('ProductionAccessEnabled', False))
        identity = aws('sesv2', 'get-email-identity', '--email-identity', DOMAIN, missing=True)
        configs = aws('sesv2', 'list-configuration-sets').get('ConfigurationSets', [])
        topics = aws('sns', 'list-topics').get('Topics', [])
        topic_exists = any(t['TopicArn'] == TOPIC_ARN for t in topics)
        if command == 'create':
            if identity is None:
                aws('sesv2', 'create-email-identity', '--email-identity', DOMAIN,
                    '--dkim-signing-attributes', '{"NextSigningKeyLength":"RSA_2048_BIT"}')
                identity = aws('sesv2', 'get-email-identity', '--email-identity', DOMAIN)
            if CONFIG not in configs:
                aws('sesv2', 'create-configuration-set', '--configuration-set-name', CONFIG,
                    '--reputation-options', '{"ReputationMetricsEnabled":false}')
            if not topic_exists:
                aws('sns', 'create-topic', '--name', TOPIC,
                    '--attributes', '{"SignatureVersion":"2"}')
            attrs = aws('sns', 'get-topic-attributes', '--topic-arn', TOPIC_ARN)['Attributes']
            if attrs.get('SignatureVersion') != '2':
                aws('sns', 'set-topic-attributes', '--topic-arn', TOPIC_ARN,
                    '--attribute-name', 'SignatureVersion', '--attribute-value', '2')
            policy = {'Version': '2012-10-17', 'Statement': [{
                'Sid': 'StagingSesEvents', 'Effect': 'Allow', 'Principal': {'Service': 'ses.amazonaws.com'},
                'Action': 'sns:Publish', 'Resource': TOPIC_ARN,
                'Condition': {'StringEquals': {'AWS:SourceAccount': ACCOUNT},
                              'ArnEquals': {'AWS:SourceArn': CONFIG_ARN}}}]}
            if json.loads(attrs.get('Policy', '{}')) != policy:
                aws('sns', 'set-topic-attributes', '--topic-arn', TOPIC_ARN,
                    '--attribute-name', 'Policy', '--attribute-value', canonical(policy))
            destination = {'Enabled': True, 'MatchingEventTypes': ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT'],
                           'SnsDestination': {'TopicArn': TOPIC_ARN}}
            destinations = aws('sesv2', 'get-configuration-set-event-destinations',
                               '--configuration-set-name', CONFIG).get('EventDestinations', [])
            existing = next((d for d in destinations if d['Name'] == TOPIC), None)
            if not destination_matches(existing, destination):
                aws('sesv2', ('create' if existing is None else 'update') + '-configuration-set-event-destination',
                    '--configuration-set-name', CONFIG, '--event-destination-name', TOPIC,
                    '--event-destination', canonical(destination))
        if identity:
            tokens = identity.get('DkimAttributes', {}).get('Tokens', [])
            if len(tokens) != 3 or any(not t.isalnum() for t in tokens):
                raise RuntimeError('Expected three Easy DKIM tokens')
            expected = [{'type': 'CNAME', 'name': f'{t}._domainkey.{DOMAIN}',
                         'content': f'{t}.dkim.amazonses.com', 'proxied': False} for t in tokens]
        if command == 'create':
            for record in expected:
                existing = [r for r in dns_before if r['name'] == record['name']]
                if existing and any(any(r.get(k) != v for k, v in record.items()) for r in existing):
                    raise RuntimeError('Existing DKIM record differs; refusing replacement')
                if not existing:
                    cf.request(cf.path, 'POST', {**record, 'ttl': 300})
            # A bounded wait; status can be rerun later without changing resources.
            for attempt in range(12):
                identity = aws('sesv2', 'get-email-identity', '--email-identity', DOMAIN)
                if identity.get('VerificationStatus') == 'SUCCESS' and identity.get('DkimAttributes', {}).get('Status') == 'SUCCESS':
                    break
                print('DKIM verification pending', attempt + 1, '/12', flush=True)
                if attempt < 11:
                    time.sleep(10)
            save('identity', identity)
            # Run create again after ST1 has configured the exact topic allowlist and keys.
            try:
                with urllib.request.urlopen(ENDPOINT.rsplit('/', 3)[0] + '/health', timeout=10) as response:
                    healthy = response.status == 200 and json.load(response).get('service') == 'mailstack'
            except (OSError, ValueError):
                healthy = False
            if healthy:
                subscriptions = aws('sns', 'list-subscriptions-by-topic', '--topic-arn', TOPIC_ARN).get('Subscriptions', [])
                matches = [s for s in subscriptions if s['Endpoint'] == ENDPOINT and s['Protocol'] == 'https']
                if not matches:
                    aws('sns', 'subscribe', '--topic-arn', TOPIC_ARN, '--protocol', 'https',
                        '--notification-endpoint', ENDPOINT, '--attributes', '{"RawMessageDelivery":"false"}')
            else:
                print('Subscription deferred until ST1. After configuring Worker, rerun create.')
        elif command == 'destroy':
            for record in expected:
                for existing in dns_before:
                    if existing['name'] == record['name']:
                        if any(existing.get(k) != v for k, v in record.items()):
                            raise RuntimeError('Existing DKIM record differs; refusing deletion')
                        cf.request(cf.path + '/' + existing['id'], 'DELETE')
            if CONFIG in configs:
                aws('sesv2', 'delete-configuration-set', '--configuration-set-name', CONFIG)
            if topic_exists:
                aws('sns', 'delete-topic', '--topic-arn', TOPIC_ARN)
            if identity:
                aws('sesv2', 'delete-email-identity', '--email-identity', DOMAIN)
            print('Staging SES/SNS/DKIM removed. IAM user and Vaultwarden entry require owner handling.')
        else:
            save('identity', identity)
            if topic_exists:
                save('topic', aws('sns', 'get-topic-attributes', '--topic-arn', TOPIC_ARN))
                save('subscriptions', aws('sns', 'list-subscriptions-by-topic', '--topic-arn', TOPIC_ARN))
            if CONFIG in configs:
                save('destinations', aws('sesv2', 'get-configuration-set-event-destinations', '--configuration-set-name', CONFIG))
        print('Identity:', DOMAIN, 'status:', (identity or {}).get('VerificationStatus', 'absent'))
    finally:
        after, dns_after, worker_after = inventory(), cf.list(cf.path), cf.fingerprint()
        save('production-after', after)
        save('dns-after', dns_after)
        save('worker-after', worker_after)
        if canonical(before) != canonical(after) or canonical(worker_before) != canonical(worker_after):
            raise RuntimeError('Production inventory or Worker deployments changed')
        delta = check_dns_delta(dns_before, dns_after, expected, command)
        save('dns-delta', delta)
        save('comparison', {'sesSns': 'IDENTICAL', 'worker': 'IDENTICAL',
                           'iam': 'UNAVAILABLE' if isinstance(after['iamUsers'], dict) else 'IDENTICAL'})
        print('Production SES/SNS and Worker: IDENTICAL; IAM:',
              'UNAVAILABLE' if isinstance(after['iamUsers'], dict) else 'IDENTICAL')
        print('Evidence:', run)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
PYTHON
