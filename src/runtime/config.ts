import { createHash } from 'node:crypto';
import { loadNodeConfig } from '../core/config/node';
export const CONFIG_JSON = JSON.stringify(loadNodeConfig());
export const BUILD_CONFIG_SHA = createHash('sha256').update(CONFIG_JSON).digest('hex');
