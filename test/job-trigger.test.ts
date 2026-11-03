import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSqliteStore } from '../src/core/store/sqlite';
import { internalFetch } from '../src/core/internal';
import { runJobs } from '../src/core/jobs';
import { createApp } from '../src/index';
import type { Env } from '../src/types';

vi.mock('../src/core/panel', () => ({ authorizePanel: vi.fn(async () => ({ id: 'panel' })) }));
vi.mock('../src/core/internal', () => ({ internalFetch: vi.fn() }));
vi.mock('../src/core/jobs', () => ({ runJobs: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

it.each([[202, 1], [200, 0], [409, 0]])('starts background jobs only after accepted work (%i)', async (status, kicks) => {
  vi.mocked(internalFetch).mockResolvedValueOnce(new Response(null, { status }));
  const store = createSqliteStore(':memory:'), waitUntil = vi.fn();
  const app = createApp({ store, access: async () => true });
  const response = await app.fetch(new Request('https://internal.example/internal/v2/privacy/erase', { method: 'POST' }),
    { PANEL_ASSERTION_KEYS: '[]', INTERNAL_HOST: 'internal.example' } as Env, { waitUntil } as unknown as ExecutionContext);
  expect(response.status).toBe(status);
  expect(waitUntil).toHaveBeenCalledTimes(kicks);
  await Promise.all(waitUntil.mock.calls.map(([task]) => task));
  // The drain gets the extension host's cleanup, so erase jobs on the Worker run extension `onBeforeDelete`.
  expect(vi.mocked(runJobs).mock.calls).toEqual(kicks ? [[store, 'request', { beforeDelete: expect.any(Function), consumers: expect.any(Map), kinds: expect.objectContaining({ erase: expect.anything() }) }]] : []);
});

it('passes the extension cleanup to the minute cron drain', async () => {
  const waitUntil = vi.fn();
  createApp().scheduled({ cron: '* * * * *', scheduledTime: 0 } as ScheduledController, { DB: {} } as unknown as Env, { waitUntil } as unknown as ExecutionContext);
  await waitUntil.mock.calls[0][0];
  expect(vi.mocked(runJobs).mock.calls).toEqual([[expect.anything(), 'cron', { notifier: undefined, beforeDelete: expect.any(Function), consumers: expect.any(Map), kinds: expect.objectContaining({ erase: expect.anything() }) }]]);
});

it('declares the minute job cron and the hourly retention cron the Worker dispatches on', () => {
  expect(readFileSync('wrangler.template.toml', 'utf8')).toContain('crons = ["* * * * *", "17 * * * *"]');
});
