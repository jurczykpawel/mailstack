import { readFileSync } from 'node:fs';
import preset from '../docs/sources/sellf.json' with { type: 'json' };
import { parseConfig } from '../src/core/config/schema.ts';

try {
  const [file, deploymentFile, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error('Usage: migrate-sellf-config.ts <config.json> [deployment-vars.json]');
  const input = JSON.parse(readFileSync(file, 'utf8'));
  const deployment = deploymentFile ? JSON.parse(readFileSync(deploymentFile, 'utf8')) : {};
  const fail = (path: string): never => { throw new Error(`${path}: ambiguous migration`); };
  const sources = input.sources ??= { sellf: structuredClone(preset) };
  const scopes = input.legacyApiKey?.scopes;
  if (scopes !== undefined && JSON.stringify(scopes) !== JSON.stringify(['send', 'hook:sellf'])) fail('$.legacyApiKey.scopes');
  for (const [id, source] of Object.entries(sources) as [string, Record<string, unknown>][]) {
    if (source.legacyKey === true && id !== 'sellf') fail(`$.sources.${id}.legacyKey`);
    if (scopes && id === 'sellf' && source.legacyKey === false) fail(`$.sources.${id}.legacyKey`);
    source.legacyKey ??= id === 'sellf';
  }
  if (input.legacyApiKey) delete input.legacyApiKey.scopes;
  const brand = deployment.SELLF_DEFAULT_BRAND;
  if (brand !== undefined && brand !== '') {
    if (typeof brand !== 'string' || !sources.sellf || !Object.hasOwn(input.brands ?? {}, brand) ||
      (sources.sellf.defaultBrand !== undefined && sources.sellf.defaultBrand !== brand)) fail('$.sources.sellf.defaultBrand');
    sources.sellf.defaultBrand = brand;
  }
  for (const [index, client] of (input.clients ?? []).entries()) {
    const alias = client.sellfSignatureSecretEnv;
    if (alias === undefined) continue;
    if (typeof alias !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/i.test(alias) ||
      (client.signatureSecretEnv !== undefined && client.signatureSecretEnv !== alias) ||
      (!client.signatureSecretEnv && client.scopes?.some((scope: string) => scope.startsWith('hook:') && scope !== 'hook:sellf')))
      fail(`$.clients.${index}.signatureSecretEnv`);
    client.signatureSecretEnv = alias;
    delete client.sellfSignatureSecretEnv;
  }
  console.log(JSON.stringify(parseConfig(input), null, 2));
} catch (error) {
  console.error(error instanceof SyntaxError ? '$: invalid JSON' : error instanceof Error ? error.message : '$: migration failed');
  process.exitCode = 1;
}
