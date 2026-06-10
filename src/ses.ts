import { AwsClient } from "aws4fetch";
import type { Env, SendParams, SendResult } from "./types";

/**
 * Send one email through the Amazon SES v2 API using SigV4 (aws4fetch).
 * Injected into the handler via SendDeps so tests never hit AWS.
 */
export async function sendEmail(
  env: Env,
  params: SendParams,
): Promise<SendResult> {
  const region = env.SES_REGION;
  const client = new AwsClient({
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    region,
    service: "ses",
  });

  const payload = {
    FromEmailAddress: params.from,
    Destination: { ToAddresses: params.to },
    ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: params.html, Charset: "UTF-8" },
          Text: { Data: params.text, Charset: "UTF-8" },
        },
      },
    },
  };

  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const res = await client.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`SES send failed: ${res.status} ${detail}`);
  }
  return { ok: res.ok, status: res.status };
}
