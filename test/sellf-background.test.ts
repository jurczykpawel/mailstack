import { expect, it, vi } from 'vitest';
import worker from '../src/index';
import { handleSellfHook } from '../src/sellf';
import type { Env } from '../src/types';

vi.mock('../src/sellf', () => ({ handleSellfHook: vi.fn(async () => Response.json({ success: true })) }));

it('passes the bound execution context to the Sellf hook', async () => {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(task: Promise<unknown>) { expect(this).toBe(ctx); tasks.push(task); },
    passThroughOnException() {},
  } as ExecutionContext;
  const response = await worker.fetch(new Request('https://mail.example/v1/hooks/sellf', { method: 'POST' }), {} as Env, ctx);
  expect(response.status).toBe(200);
  const deps = vi.mocked(handleSellfHook).mock.calls[0][2];
  expect(deps.waitUntil).toBeTypeOf('function');
  const task = Promise.resolve();
  deps.waitUntil!(task);
  expect(tasks).toEqual([task]);
});
