import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
function script(name: string) {
  const block = workflow.split(`- name: ${name}\n`)[1];
  expect(block, `missing ${name} step`).toBeDefined();
  return block.split('run: |\n')[1].split(/\n      - /)[0].split('\n').map(line => line.slice(10)).join('\n');
}

it('gates publication on validation with scoped permissions and pinned actions', () => {
  expect(workflow).toMatch(/image:\n    needs: validate/);
  expect(workflow).toContain('permissions: {contents: read, packages: write}');
  for (const action of workflow.matchAll(/uses: (.+)/g)) expect(action[1]).toMatch(/@[a-f0-9]{40} # v[0-9.]+$/);
  expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
  expect(workflow).toContain('cache-from: type=gha');
  expect(workflow).toContain('cache-to: type=gha,mode=max');
  for (const label of ['source', 'revision', 'version', 'licenses']) expect(workflow).toContain(`org.opencontainers.image.${label}=`);
  expect(workflow).toContain('org.opencontainers.image.licenses=MIT');
  expect(workflow.indexOf('- name: Smoke')).toBeLessThan(workflow.indexOf('- name: Publish'));
  expect(workflow).not.toMatch(/push: true/);
});

it.each([
  ['v1.2.3', ['1.2.3', 'sha-abc123', 'latest']],
  ['v1.2.3-rc.1', ['1.2.3-rc.1', 'sha-abc123']],
])('publishes %s tags from the tested multi-platform archive', (ref, tags) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-release-'));
  try {
    const executable = join(dir, 'skopeo');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n');
    chmodSync(executable, 0o755);
    const calls = join(dir, 'calls');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script('Publish')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, REGISTRY_TOKEN: 'example',
        GITHUB_ACTOR: 'example', GITHUB_REF_NAME: ref, GITHUB_SHA: 'abc123' }, encoding: 'utf8',
    });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const commands = readFileSync(calls, 'utf8').trim().split('\n');
    expect(commands).toHaveLength(tags.length + 1);
    for (const [index, tag] of tags.entries()) {
      expect(commands[index + 1]).toContain('copy --all');
      expect(commands[index + 1]).toContain(`oci-archive:/tmp/mailstack.tar docker://ghcr.io/jurczykpawel/mailstack:${tag}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('checks both health fields with bounded retries and disposable read-only configuration', () => {
  const smoke = script('Smoke');
  expect(smoke).toContain('oci-archive:/tmp/mailstack.tar docker-daemon:mailstack:smoke');
  expect(smoke).toContain(':ro'); expect(smoke).toContain('--read-only');
  expect(smoke).toContain('--tmpfs /data:uid=1000,gid=1000');
  expect(smoke).toContain('timeout 60');
  expect(smoke).toContain('h.ok!==true'); expect(smoke).toContain('h.store!==');
  expect(smoke).toContain('trap '); expect(smoke).toContain('docker rm -f smoke');
  expect(smoke).toContain('docker stop smoke');
});

it.each([
  [{ ok: true, store: 'ok' }, 0],
  [{ ok: false, store: 'ok' }, 1],
  [{ ok: true, store: 'down' }, 1],
])('smoke result for %j is %s and always removes the container', (health, status) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-smoke-'));
  try {
    const stubs: Record<string, string> = {
      sudo: 'exit 0', skopeo: 'exit 0', jq: 'echo "{}"',
      timeout: 'shift; exec "$@"',
      docker: `printf '%s\\n' "$1" >> "$CALLS"
case "$1" in
  inspect) echo healthy;;
  exec) shift 4; exec node -e 'globalThis.fetch=async()=>({ok:true,json:async()=>JSON.parse(process.env.HEALTH)});'"$1";;
esac`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755);
    }
    const calls = join(dir, 'calls');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script('Smoke')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, RUNNER_TEMP: dir, HEALTH: JSON.stringify(health) }, encoding: 'utf8',
    });
    expect(result.stderr).toBe(''); expect(result.status).toBe(status);
    const commands = readFileSync(calls, 'utf8').trim().split('\n');
    expect(commands.slice(-2)).toEqual(['logs', 'rm']);
    expect(commands.includes('stop')).toBe(status === 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
