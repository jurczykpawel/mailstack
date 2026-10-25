import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { handleSend } from '../src/send';
import { handleSellfHook } from '../src/sellf';
import { handleSesEvent } from '../src/events/ses';
import { createNtfyNotifier } from '../src/adapters/notify/ntfy';
import type { Env } from '../src/types';

vi.mock('../src/send', () => ({ handleSend: vi.fn(async () => new Response()) }));
vi.mock('../src/sellf', () => ({ handleSellfHook: vi.fn(async () => new Response()) }));
vi.mock('../src/events/ses', () => ({ handleSesEvent: vi.fn(async () => new Response()) }));
vi.mock('../src/core/keyring', () => ({ parseKeyring: vi.fn(() => ({ contentKeys: [], indexKeys: [] })) }));
vi.mock('../src/adapters/notify/ntfy', () => ({ createNtfyNotifier: vi.fn(() => ({ notify: vi.fn() })) }));
afterEach(() => vi.clearAllMocks());

it.each(['/v1/send', '/v1/hooks/sellf', '/v1/events/ses'])('supplies the shared background dependencies for %s', async path => {
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { expect(this).toBe(ctx); tasks.push(task); } } as ExecutionContext;
  const env = { NTFY_URL: 'https://ntfy.example/demo', PANEL_URL: 'https://panel.example' } as Env;
  expect((await createApp().fetch(new Request('https://mail.example' + path, { method: 'POST' }), env, ctx)).status).toBe(200);
  const deps = path === '/v1/send' ? vi.mocked(handleSend).mock.calls[0][2]
    : path === '/v1/hooks/sellf' ? vi.mocked(handleSellfHook).mock.calls[0][2] : vi.mocked(handleSesEvent).mock.calls[0][1];
  expect(createNtfyNotifier).toHaveBeenCalledTimes(1);
  expect(deps.notifier).toBe(vi.mocked(createNtfyNotifier).mock.results[0].value);
  expect(deps.waitUntil).toBeTypeOf('function');
  const task = Promise.resolve(); deps.waitUntil!(task); expect(tasks).toEqual([task]);
  if (path === '/v1/events/ses') expect(deps).toMatchObject({ panelUrl: env.PANEL_URL });
});
