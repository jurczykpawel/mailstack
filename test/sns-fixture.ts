import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { join } from 'node:path';

import { topic } from './sns-fixture-options';
export { topic, options } from './sns-fixture-options';
export function certificates() {
  const dir = mkdtempSync('.sns-test-');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
      '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=sns.eu-west-1.amazonaws.com'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } finally { rmSync(dir, { recursive: true }); }
}
export function notification(eventType = 'Delivery', extra: Record<string, unknown> = {}) {
  return { eventType, mail: { messageId: 'provider-1', tags: { ms_id: ['msg_1'] }, destination: ['one@example.com', 'two@example.com'] },
    delivery: { timestamp: new Date().toISOString(), recipients: ['one@example.com'], smtpResponse: '250 one@example.com\u0000 OK' }, ...extra };
}
export function signed(key: string, event = notification(), overrides: Record<string, string> = {}) {
  const body: Record<string, string> = { Type: 'Notification', MessageId: crypto.randomUUID(), Message: JSON.stringify(event),
    TopicArn: topic, Timestamp: new Date().toISOString(), SignatureVersion: '2',
    SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/cert.pem', ...overrides };
  const fields = body.Type === 'Notification' ? ['Message', 'MessageId', ...(Object.hasOwn(body, 'Subject') ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  body.Signature = sign(body.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256', Buffer.from(fields.map(k => `${k}\n${body[k]}\n`).join('')), createPrivateKey(key)).toString('base64');
  return body;
}
export const request = (body: Record<string, string>, header = body.Type) => new Request('https://mail.example/v1/events/ses', {
  method: 'POST', headers: { 'x-amz-sns-message-type': header }, body: JSON.stringify(body),
});
