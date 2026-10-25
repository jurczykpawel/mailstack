import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({ entryPoints: ['src/runtime/node-api.ts'], outfile: 'dist/node-api.mjs', bundle: true, platform: 'node',
  format: 'esm', packages: 'external', plugins: [{ name: 'runtime-config', setup(build) {
    build.onResolve({ filter: /\/bundled\.ts$/ }, () => ({ path: resolve('src/runtime/config.ts') }));
    build.onResolve({ filter: /\/assets\/logo$/ }, () => ({ path: resolve('src/assets/logo.example.ts') }));
  } }],
});
