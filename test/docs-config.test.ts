import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseConfig } from '../src/core/config/schema';

it('validates the complete README configuration example', () => {
  const readme = readFileSync('README.md', 'utf8');
  const section = readme.split('### Complete configuration example\n')[1];
  expect(section).toBeDefined();
  const block = section?.match(/```json\n([\s\S]*?)\n```/);
  expect(block).toBeTruthy();
  expect(() => parseConfig(JSON.parse(block![1]))).not.toThrow();
});
