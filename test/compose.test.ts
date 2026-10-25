import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each([['', '127.0.0.1'], ['0.0.0.0', '0.0.0.0']])('resolves the API bind address: %s', (bind, expected) => {
  const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'docker-compose.yml', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, MAILSTACK_BIND: bind, MAILSTACK_PORT: '', MAILSTACK_ENV_FILE: '/dev/null', MAILSTACK_CONFIG: './config/mailstack.example.json' },
  }));
  expect(config.services.api.ports).toEqual([expect.objectContaining({ host_ip: expected, published: '8080', target: 8080 })]);
});
