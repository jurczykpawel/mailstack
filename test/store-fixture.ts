import type { Store } from '../src/core/ports';

export function memoryStore(): Store {
  const guards = new Map<string, { count: number; expires: number }>();
  return {
    async migrate() {},
    async consume(key, expires) {
      if (guards.has(key)) return false;
      guards.set(key, { count: 1, expires });
      return true;
    },
    async increment(key, expires) {
      const value = guards.get(key) ?? { count: 0, expires };
      value.count++;
      guards.set(key, value);
      return value.count;
    },
    async purgeGuards(now) {
      for (const [key, value] of guards) if (value.expires <= now) guards.delete(key);
    },
  };
}
