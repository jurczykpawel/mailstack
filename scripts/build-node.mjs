import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({ entryPoints: ['src/runtime/node-api.ts'], outfile: 'dist/node-api.mjs', bundle: true, platform: 'node',
  format: 'esm', packages: 'external', plugins: [{ name: 'runtime-config', setup(build) {
    build.onResolve({ filter: /\/bundled\.ts$/ }, () => ({ path: resolve('src/runtime/config.ts') }));
    build.onResolve({ filter: /\/assets\/logo$/ }, () => ({ path: resolve('src/assets/logo.example.ts') }));
    // Node loads Mailstack Pro as a runtime extension, never the Worker build.
    build.onResolve({ filter: /\/pro\.generated$/ }, () => ({ path: 'pro', namespace: 'node' }));
    build.onLoad({ filter: /.*/, namespace: 'node' }, () => ({ contents: 'export const proKeys = undefined;', loader: 'js' }));
  } }],
});
