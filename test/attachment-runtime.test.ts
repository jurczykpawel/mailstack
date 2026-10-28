import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('keeps sequential attachment sends within the API profile budget', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/attachment-profile.mjs'], { timeout: 60000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  expect(result.peakRss).toBeLessThan(384 * 1024 * 1024);
  expect(result.checksums.some((f: { bytes: number }) => f.bytes === 7 * 1024 * 1024)).toBe(true);
}, 65000);
