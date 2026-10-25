import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Sender } from '../../core/ports';
import type { SendParams } from '../../types';

interface Reply { response: string; accepted: string[]; rejected: string[]; serverMessageId?: string }
interface Transport { sendMail(params: Omit<SendParams, 'messageId' | 'brand'> & { disableFileAccess: boolean; disableUrlAccess: boolean }): Promise<Reply> }
export function createSmtpSender(transport: Transport): Sender {
  return async (_env, { messageId: _id, brand: _brand, ...params }) => {
    try {
      const info = await transport.sendMail({ ...params, disableFileAccess: true, disableUrlAccess: true });
      const messageId = info.serverMessageId ?? info.response.match(/queued as\s+<?([^\s>]+)/i)?.[1] ?? info.response.match(/OK[: ]+\s*<?([^\s>]+)/i)?.[1] ?? '';
      return { ok: true, status: Number(info.response.slice(0, 3)), messageId,
        response: { response: info.response }, smtp: { accepted: info.accepted, rejected: info.rejected } };
    } catch (error) {
      const reply = z.object({ responseCode: z.number().int().min(400).max(599), response: z.string() }).safeParse(error);
      if (!reply.success) throw error;
      return { ok: false, status: reply.data.responseCode, response: { response: reply.data.response } };
    }
  };
}
export function smtpFromEnv(env: NodeJS.ProcessEnv): Sender {
  const common = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000, pool: false as const };
  if (env.SMTP_URL) {
    const url = new URL(z.url().refine(v => /^smtps?:/.test(v)).parse(env.SMTP_URL));
    env = { SMTP_HOST: url.hostname.replace(/^\[|\]$/g, ''), SMTP_PORT: url.port || (url.protocol === 'smtps:' ? '465' : '587'),
      SMTP_SECURE: String(url.protocol === 'smtps:'), SMTP_USER: decodeURIComponent(url.username) || undefined,
      SMTP_PASS: decodeURIComponent(url.password) || undefined };
  }
  const options = z.object({ host: z.string().min(1), port: z.coerce.number().int().min(1).max(65535),
    secure: z.enum(['true', 'false']).transform(v => v === 'true'), user: z.string().optional(), pass: z.string().optional(),
  }).refine(v => !!v.user === !!v.pass).parse({ host: env.SMTP_HOST, port: env.SMTP_PORT ?? '587',
    secure: env.SMTP_SECURE ?? 'false', user: env.SMTP_USER, pass: env.SMTP_PASS });
  return createSmtpSender(nodemailer.createTransport({ ...common, host: options.host, port: options.port, secure: options.secure,
    ...(options.user ? { auth: { user: options.user, pass: options.pass } } : {}) }));
}
