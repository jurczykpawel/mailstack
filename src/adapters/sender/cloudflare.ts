import type { Env, SendParams, SendResult } from '../../types';

// Workers binding error codes (developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes) -> HTTP-like status for the log.
const STATUS: Record<string, number> = {
  E_RECIPIENT_NOT_ALLOWED: 403, E_RECIPIENT_PLAN_RESTRICTED: 403, E_SENDER_NOT_VERIFIED: 403, E_SENDER_DOMAIN_NOT_AVAILABLE: 403, E_RECIPIENT_SUPPRESSED: 403,
  E_ACCOUNT_SUSPENDED: 403, E_CONTENT_TOO_LARGE: 413, E_RATE_LIMIT_EXCEEDED: 429, E_DAILY_LIMIT_EXCEEDED: 429, E_DELIVERY_FAILED: 502,
};
const HINT: Record<string, string> = {
  E_RECIPIENT_NOT_ALLOWED: 'recipient not allowed by the send_email binding',
  // Measured on Workers Free (2026-11-28), not in the documented list: a recipient that is not a verified destination address.
  E_RECIPIENT_PLAN_RESTRICTED: 'recipient is not a verified destination address (Workers Free sends only to verified addresses)',
  E_SENDER_NOT_VERIFIED: 'the sender domain is not enabled for Email Service in this account',
  E_SENDER_DOMAIN_NOT_AVAILABLE: 'the sender domain is not enabled for Email Service in this account',
};

/** `Name <addr>` or a bare address -> the binding's sender shape. */
function sender(from: string) {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return match ? { email: match[2].trim(), name: match[1].trim() } : from.trim();
}

/** Send one email through the Cloudflare Email Service Workers binding (`send_email`, name EMAIL). */
export async function sendCloudflare(env: Env, params: SendParams): Promise<SendResult> {
  if (!env.EMAIL) {
    console.error('Cloudflare Email Service: the send_email binding EMAIL is missing; run npm run setup with "sender": {"type": "cloudflare"}');
    return { ok: false, status: 500, response: { code: 'E_BINDING_MISSING' } };
  }
  try {
    const { messageId } = await env.EMAIL.send({
      from: sender(params.from), to: params.to, ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      subject: params.subject, html: params.html, text: params.text,
      ...(params.attachments?.length ? { attachments: params.attachments.map(file => ({
        filename: file.filename, type: file.contentType, disposition: 'attachment' as const,
        content: Uint8Array.from(atob(file.contentBase64), c => c.charCodeAt(0)),
      })) } : {}),
    });
    return { ok: true, status: 200, messageId, response: { messageId } };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    // No code or a temporary service error: the message may have left, so the caller records an uncertain outcome.
    if (!code || code === 'E_INTERNAL_SERVER_ERROR') throw error;
    console.error(`Cloudflare Email Service refused: ${code}${HINT[code] ? ` - ${HINT[code]}` : ''}`);
    return { ok: false, status: STATUS[code] ?? 400, response: { code } };
  }
}
