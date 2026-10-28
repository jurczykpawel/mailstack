import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
import { join } from 'node:path';
const [core, pro, state] = process.argv.slice(2);
process.umask(0o077);
const put = (p, v) => writeFileSync(join(state, p), typeof v === 'string' ? v : JSON.stringify(v, null, 2), { mode: 0o600 });
for (const p of ['fixture', 'seed']) mkdirSync(join(state, p), { recursive: true });
execFileSync('node', [join(pro, 'scripts/init-install.mjs'), join(state, 'install')]);
const random = () => randomBytes(32).toString('base64url');
const tokens = {}, clients = [];
for (const [id, scopes, brands, templates, override, attachments] of [
  ['send', ['send'], '*', '*', true, true], ['limited', ['send'], ['acme'], ['payment'], false, false],
  ['source', ['send'], ['acme'], ['license'], true, false], ['hook', ['hook:sellf'], ['acme'], '*', true, false],
  ['panel', ['panel', 'webhooks:write'], '*', '*', false, false], ['empty', ['panel'], [], [], false, false],
]) {
  tokens[id] = 'msk_' + id + '_' + random();
  clients.push({ id, scopes, brands, templates, recipientOverride: override, attachments,
    tokenSha256: createHash('sha256').update(tokens[id]).digest('hex'),
    ...(id === 'source' ? { resendCallback: { url: 'https://source.test.example/callback', secretEnv: 'TEST_CALLBACK_SECRET' } } : {}),
    ...(id === 'hook' ? { sellfSignatureSecretEnv: 'TEST_SELLF_SECRET' } : {}) });
}
tokens.callbackSecret = random(); tokens.webhookSecret = random(); tokens.sellfSecret = random(); tokens.legacy = random();
put('seed/tokens.json', tokens); put('fixture/credentials.json', tokens);
const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
put('fixture/license.key', key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
put('fixture/license.pub', key.publicKey.export({ type: 'spki', format: 'pem' }));
const variants = {};
for (const variant of ['valid', 'expired', 'wrong-domain', 'revoked', 'bad-signature', 'missing']) {
  const now = Math.floor(Date.now()/1000);
  const claims = { v: 1, kid: 'test-es256', product: 'mailstack-pro-test', email: 'buyer@acme.example',
    order: variant === 'revoked' ? 'test-revoked' : 'test-' + variant, tier: 'test', iat: now - 3600,
    exp: variant === 'expired' ? now - 1 : now + 30 * 86400, domain: variant === 'wrong-domain' ? 'other.example' : 'test.example' };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = variant === 'missing' ? '' : payload + '.' + sign('sha256', Buffer.from(payload), key.privateKey).toString('base64url');
  variants[variant] = { license: variant === 'bad-signature' ? token.slice(0, -8) + 'AAAAAAAA' : token,
    product: 'mailstack-pro-test', host: 'panel.test.example', seller: 'test-seller', jwksUrl: 'https://license.test.example/jwks',
    revocationUrl: 'https://license.test.example/crl', cachePath: '/data/license-cache.json' };
}
put('license-variants.json', variants);
put('install/secrets/panel/license.json', variants.valid);
put('install/secrets/panel/token', tokens.panel);
const cfg = JSON.parse(readFileSync(join(state, 'install/config/api.json')));
cfg.brands = JSON.parse(readFileSync(join(core, 'config/mailstack.example.json'))).brands;
for (const brand of Object.values(cfg.brands)) {
  brand.allowedOrigins = ['http://localhost:18882', 'https://localhost:18890', 'https://' + brand.id + '.example'];
  brand.captcha = 'altcha'; brand.subjectPrefix = 'Wiadomość testowa'; brand.theme.logoUrl = 'http://localhost:18880/brand/logo.png';
}
cfg.brands['selfware-like'] = { ...cfg.brands.demo, id: 'selfware-like', name: 'Test nonce', requireNonce: true, products: ['Produkt Żółw', 'Test Pro'], to: ['inbox@selfware.example'], allowedOrigins: ['http://localhost:18882', 'https://selfware.example'] };
cfg.clients = clients; cfg.legacyApiKey = { enabled: true, env: 'API_KEY' };
cfg.logging.defaults = { ...cfg.logging.defaults, level: 'meta', alertOn: ['bounce_permanent', 'complaint', 'send_failed', 'unknown'] };
cfg.logging.brands = { acme: { templates: {
  contact: { level: 'full' }, payment: { level: 'masked', show: ['amount', 'currency', 'item', 'orderId', 'date'], resend: 'off' },
  license: { level: 'masked', show: ['productName', 'tier', 'domain'], resend: 'source', requireLog: true },
  welcome: { level: 'none' }, received: { level: 'full' }, notice: { level: 'meta' },
} } };
cfg.logging.patterns = [{ name: 'url-secrets', urlParams: ['token','key','code','sig','otp'] }];
cfg.events = { ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:mailstack-test'], accountIds: ['123456789012'], allowSignatureV1: false } };
cfg.extensions = [{ module: '/workspace/mailstack-pro/dist/manual-extension.mjs', options: { ...variants.valid,
  webhooks: { keyEnv: 'PRO_WEBHOOK_KEY', endpoints: [{ id: 'test-receiver', url: 'https://hooks.test.example/events', secretEnv: 'TEST_WEBHOOK_SECRET', events: ['message.sent','message.bounced','message.complained','form.submitted'], brands: ['acme'], includeRef: true }] } } }];
delete cfg.extensions[0].options.webhooks.endpoints[0].templates;
put('install/config/api.json', cfg);
const envFile = readFileSync(join(state, 'install/api.env'), 'utf8') +
  'BUILD_COMMIT=' + execFileSync('git',['-C',core,'rev-parse','HEAD'],{encoding:'utf8'}).trim() + '\nAPI_KEY=' + tokens.legacy + '\nALTCHA_HMAC_KEY=' + random() + '\nTEST_CALLBACK_SECRET=' + tokens.callbackSecret +
  '\nTEST_WEBHOOK_SECRET=' + tokens.webhookSecret + '\nTEST_SELLF_SECRET=' + tokens.sellfSecret + '\nNTFY_URL=http://fixture:8082/ntfy\n';
put('install/api.env', envFile);
const publicKeys = JSON.parse(envFile.match(/^CONTENT_PUBLIC_KEYS=(.*)$/m)[1]);
put('seed/public-keys.json', publicKeys);
put('seed/index-keys.json', JSON.parse(envFile.match(/^INDEX_KEYS=(.*)$/m)[1]));
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(state,'fixture/tls.key'),'-out',join(state,'fixture/tls.crt'),'-days','30','-subj','/CN=fixture','-addext','subjectAltName=DNS:fixture,DNS:localhost'], { stdio: 'ignore' });
execFileSync('node', [join(pro,'scripts/container-context.mjs'), core, join(state,'context')]);
cpSync(join(pro,'scripts/manual'), join(state,'context/mailstack-pro/scripts/manual'), { recursive: true });
cpSync(join(core,'scripts/manual'), join(state,'context/mailstack/scripts/manual'), { recursive: true });
mkdirSync(join(state,'context/mailstack/config'), { recursive:true });
cpSync(join(core,'config/mailstack.example.json'), join(state,'context/mailstack/config/mailstack.example.json'));
cpSync(join(pro,'scripts/manual/Dockerfile'), join(state,'context/Dockerfile'));
put('status.json', { api: 'http://localhost:18880', panel: 'https://localhost:18890', mailpit: 'http://localhost:18825', playground: 'http://localhost:18882', fixture: 'https://localhost:18843', tokens, source: { core:execFileSync('git',['-C',core,'rev-parse','HEAD'],{encoding:'utf8'}).trim(), pro:execFileSync('git',['-C',pro,'rev-parse','HEAD'],{encoding:'utf8'}).trim() }, accounts: 'Use invite viewer/operator/admin, then Chrome CDP resident passkey; no owner accounts exist.', ownerDigest: createHash('md5').update('[]').digest('hex') });
