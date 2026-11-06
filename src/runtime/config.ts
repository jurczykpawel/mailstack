import { createHash } from 'node:crypto';
import { loadNodeConfig } from '../core/config/node';
import { templatePlans } from '../templates/config.ts';
export const VALIDATED_CONFIG = loadNodeConfig();
export const TEMPLATE_PLANS = templatePlans(VALIDATED_CONFIG);
export const CONFIG_JSON = JSON.stringify(VALIDATED_CONFIG);
export const BUILD_CONFIG_SHA = createHash('sha256').update(CONFIG_JSON).digest('hex');
