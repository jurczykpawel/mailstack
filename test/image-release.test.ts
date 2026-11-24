import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const SMOKE = '.github/scripts/smoke-image.sh';
function script(name: string) {
  const block = workflow.split(`- name: ${name}\n`)[1];
  expect(block, `missing ${name} step`).toBeDefined();
  return block.split('run: |\n')[1].split(/\n      - /)[0].split('\n').map(line => line.slice(10)).join('\n');
}

it('builds each platform natively and gates publication on validation, smoke and a tag', () => {
  expect(workflow).toMatch(/image:\n    needs: validate/);
  expect(workflow).toContain('permissions: {contents: read, packages: write}');
  // Validation reuses CI from the same commit; every external action is pinned.
  expect(workflow).toMatch(/validate:\n    uses: \.\/\.github\/workflows\/ci\.yml\n/);
  for (const file of [workflow, readFileSync('.github/workflows/ci.yml', 'utf8')]) {
    for (const action of file.matchAll(/uses: (.+)/g))
      if (action[1] !== './.github/workflows/ci.yml') expect(action[1]).toMatch(/@[a-f0-9]{40} # v[0-9.]+$/);
    // QEMU emulation crashed npm ci on arm64: both platforms build on native runners.
    expect(file).not.toContain('setup-qemu');
    expect(file).toContain('{platform: linux/arm64, runner: ubuntu-24.04-arm');
    expect(file).toContain('run: .github/scripts/smoke-image.sh mailstack:smoke');
  }
  expect(workflow).toContain('cache-to: type=gha,scope=${{ matrix.arch }},mode=max');
  for (const label of ['source', 'revision', 'version', 'licenses']) expect(workflow).toContain(`org.opencontainers.image.${label}=`);
  expect(workflow).toContain('org.opencontainers.image.licenses=MIT');
  expect(workflow).toContain('push-by-digest=true');
  expect(workflow.indexOf('- name: Smoke')).toBeLessThan(workflow.indexOf('- id: push'));
  expect(workflow).toMatch(/push:\n    tags: \["v\*"\]\n  # [^\n]*\n  workflow_dispatch:\n/);
  expect(workflow).toMatch(/publish:\n    needs: image\n    if: github.event_name == 'push'\n/);
  const image = workflow.slice(workflow.indexOf('\n  image:'), workflow.indexOf('\n  publish:'));
  const publishing = image.split(/\n      - /).filter(step => /docker login|id: push|digest/.test(step));
  expect(publishing).toHaveLength(4);
  for (const step of publishing) expect(step).toContain("if: github.event_name == 'push'");
  expect(workflow).not.toMatch(/push: true/);
});

it.each([
  ['v1.2.3', ['1.2.3', 'sha-abc123', 'latest'], 2, 0],
  ['v1.2.3-rc.1', ['1.2.3-rc.1', 'sha-abc123'], 2, 0],
  ['v1.2.3', [], 1, 1],
])('publishes %s tags from both platform digests', (ref, tags, digests, status) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-release-')), work = join(dir, 'digests');
  try {
    mkdirSync(work); for (let i = 0; i < digests; i++) writeFileSync(join(work, `${i}`.repeat(64)), '');
    const executable = join(dir, 'docker');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n');
    chmodSync(executable, 0o755);
    const calls = join(dir, 'calls');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script('Publish')], {
      cwd: work, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, REGISTRY_TOKEN: 'example', IMAGE: 'ghcr.io/jurczykpawel/mailstack',
        GITHUB_ACTOR: 'example', GITHUB_REF_NAME: ref, GITHUB_SHA: 'abc123' }, encoding: 'utf8',
    });
    expect(result.status).toBe(status);
    const commands = readFileSync(calls, 'utf8').trim().split('\n');
    if (status) { expect(commands).toHaveLength(1); return; }
    expect(commands).toHaveLength(3);
    expect(commands[1]).toBe(['buildx imagetools create', ...tags.map(tag => `-t ghcr.io/jurczykpawel/mailstack:${tag}`),
      ...['0', '1'].map(d => `ghcr.io/jurczykpawel/mailstack@sha256:${d.repeat(64)}`)].join(' '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('checks both health fields with bounded retries and disposable read-only configuration', () => {
  const smoke = readFileSync(SMOKE, 'utf8');
  expect(smoke).toContain('"$image"');
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
    const result = spawnSync('bash', [SMOKE, 'mailstack:smoke'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, RUNNER_TEMP: dir, HEALTH: JSON.stringify(health) }, encoding: 'utf8',
    });
    expect(result.stderr).toBe(''); expect(result.status).toBe(status);
    const commands = readFileSync(calls, 'utf8').trim().split('\n');
    expect(commands.slice(-2)).toEqual(['logs', 'rm']);
    expect(commands.includes('stop')).toBe(status === 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
