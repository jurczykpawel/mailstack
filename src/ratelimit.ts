import type { Store } from './core/ports';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS = 8;

export async function checkRateLimit(
  store: Store | undefined,
  brand: string,
  ip: string,
  now = new Date(),
): Promise<boolean> {
  try {
    if (!store) return true;
    const window = Math.floor(now.getTime() / WINDOW_MS);
    const key = `rl:${brand}:${ip || 'unknown'}:${window}`;
    return await store.increment(key, (window + 1) * WINDOW_MS) <= MAX_REQUESTS;
  } catch {
    return true;
  }
}
