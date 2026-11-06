import example from '../../config/mailstack.example.json';
import presentation from './templates/form-presentation.json';
import { parseConfig } from '../../src/core/config/schema.ts';
import type { Brand } from '../../src/types.ts';
export const formConfig = (brand: Brand) => parseConfig({ ...structuredClone(example), mailTemplates: { version: 1 },
  brands: { [brand.id]: { ...brand, mailTemplates: presentation } } });
