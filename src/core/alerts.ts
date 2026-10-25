import type { Notifier, Store } from './ports';
import { config } from './config';
import type { Config } from './config/schema';
import { resolvePolicy } from './logging/policy';
import { getTemplate } from '../templates';

export async function alertMessage(store: Store | undefined, notifier: Notifier | undefined, id: string, type: string,
  now: number, logging: Config['logging'] = config.logging, panelUrl?: string, pos?: number, summary = type): Promise<void> {
  if (!store || !notifier) return;
  try {
    const message = await store.alertContext(id, pos);
    if (!message) return;
    const { policy } = await resolvePolicy(logging, message.brand, message.template);
    if (!policy.alertOn.some(value => value === type)) return;
    if (!await store.consume('alert:' + id + ':' + type, now + (policy.metaDays ?? 7) * 86400000)) return;
    const clean = (summary.match(/\b(?:Permanent|Transient|Undetermined|[245]\.\d{1,3}\.\d{1,3}|[245]\d{2})\b/g) ?? [type]).join(' ').slice(0, 200);
    await notifier.notify({ title: 'mailstack: ' + type + ' ' + message.brand + '/' + message.template,
      body: message.addr_hint + ' · ' + clean,
      priority: getTemplate(message.template)?.secretFields?.length ? 'high' : 'default',
      ...(panelUrl ? { click: panelUrl.replace(/\/$/, '') + '/m/' + id } : {}) });
  } catch { console.error('mailstack: alert failed'); }
}
