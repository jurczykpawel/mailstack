import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { internalFetch } from '../core/internal';
import { authorizePanel } from '../core/panel';
import { createExtensionHost } from '../core/extension-host';
import type { KyselyStore } from '../core/store';
import type { Config } from '../core/config/schema';
import type { SendDeps } from '../types';

/** Node host: modules by dynamic import, plus the internal listener for `/internal/v2/*` and `/internal/ext/*`. */
export async function loadExtensions(config: Config, store: KyselyStore,
  importer: (module: string) => Promise<{ default?: unknown }> = module => import(module),
  delivery?: Pick<SendDeps, 'sendEmail' | 'provider'>) {
  const host = await createExtensionHost(config, store, module => importer(isAbsolute(module) ? pathToFileURL(module).href : module), { delivery });
  return { ...host, async fetch(req: Request, env: object): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith('/internal/v2/') && !pathname.startsWith('/internal/ext/')) return new Response(null, { status: 404 });
    const panel = await authorizePanel(req, env, config, { audience: String(Reflect.get(env, 'PANEL_AUDIENCE') ?? ''), store, keys: host.keys });
    if (panel instanceof Response) return panel;
    return pathname.startsWith('/internal/v2/') ? internalFetch(req, env, store, config, panel, host.beforeDelete) : host.route(req, env, panel);
  } };
}
