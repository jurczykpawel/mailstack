import { tokenMatches, type Client, type KeyProvider } from "../../src/clients";
import type { Config } from "../../src/core/config/schema";

// Stand-in for the Mailstack Pro key provider: reads `config.clients` on each call so tests can
// exercise the core's enforcement of scoped principals. Validation and licensing are tested in Pro.
export function testKeys(config: Pick<Config, "clients">): KeyProvider {
  const find = (id?: string) => {
    const entry = config.clients?.find((client) => client.id === id);
    return entry && ({ brands: [], templates: [], recipientOverride: false, attachments: false, ...entry } as unknown as Client & { tokenSha256: string });
  };
  return {
    client: find,
    async authenticate(token) {
      const client = find(/^msk_([a-z0-9-]+)_/.exec(token)?.[1]);
      return client && await tokenMatches(token, client.tokenSha256) ? client : null;
    },
  };
}
/** Adds the stand-in key provider to an extension under test. */
export const withKeys = <T extends object>(extension: T) => ({ ...extension, keys: testKeys });
/** Loads core extensions with only the stand-in key provider configured. */
export const keysOnly = <C extends Config>(config: C): [C, (module: string) => Promise<{ default: unknown }>] =>
  [{ ...config, extensions: [{ module: "keys" }] }, async () => ({ default: { name: "keys", keys: testKeys } })];
