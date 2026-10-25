import type { Notifier } from '../../core/ports';
import type { Env } from '../../types';

export function createNtfyNotifier(env: Pick<Env, 'NTFY_URL' | 'NTFY_TOKEN'>, fetcher: typeof fetch = fetch): Notifier {
  return { async notify(alert) {
    if (!env.NTFY_URL) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const result = await fetcher(env.NTFY_URL, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Title: alert.title, Priority: alert.priority, ...(alert.click ? { Click: alert.click } : {}),
          ...(env.NTFY_TOKEN ? { Authorization: 'Bearer ' + env.NTFY_TOKEN } : {}) }, body: alert.body });
      await result.body?.cancel();
      if (!result.ok) throw new Error('Notification failed');
    } finally { clearTimeout(timer); }
  } };
}
