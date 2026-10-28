import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each D1 suite starts its own workerd runtime.
    maxWorkers: 2,
  },
});
