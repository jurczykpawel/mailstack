import { expect, it } from 'vitest';
import { buildBlocks } from '../src/markup';
import { humanizeLabel } from '../src/templates/layout';
import { getBrand } from '../src/core/config';
import { effectivePolicies, parseConfig } from '../src/core/config/schema';
import { resolvePolicy } from '../src/core/logging/policy';
import example from '../config/mailstack.example.json';

const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

it.each(names)('drops unknown markup kind %s', kind => {
  expect(buildBlocks([{ kind }])).toEqual([]);
});

it.each([['__proto__', 'Proto'], ['constructor', 'Constructor'], ['toString', 'ToString'],
  ['hasOwnProperty', 'HasOwnProperty'], ['valueOf', 'ValueOf']])('formats custom field %s', (key, label) => {
  expect(humanizeLabel(key)).toBe(label);
});

it.each(names)('returns no brand for unregistered id %s', id => {
  expect(getBrand(id)).toBeUndefined();
});

it.each(['runtime', 'schema'].flatMap(target => ['brand', 'template'].map(layer => [target, layer])))('resolves %s defaults for absent %s entries', async (target, layer) => {
  const config = parseConfig(example);
  const inherited = { notice: { requireLog: true } };
  if (layer === 'brand') config.logging.brands = Object.create({ acme: { defaults: { requireLog: true } } });
  else config.logging.brands.acme = { templates: Object.create(inherited) };
  const policy = target === 'runtime' ? (await resolvePolicy(config.logging, 'acme', 'notice')).policy
    : effectivePolicies(config).find(p => p.brandId === 'acme' && p.templateId === 'notice')?.policy;
  expect(policy).toEqual(config.logging.defaults);
});

it('validates declared template metadata only', () => {
  const config = parseConfig(example);
  config.logging.defaults.level = 'full';
  config.logging.defaults.resend = 'replay';
  config.logging.brands.acme = { templates: { notice: {} } };
  expect(() => parseConfig(config, Object.create({ notice: { secretFields: ['key'] } }))).not.toThrow();
});
