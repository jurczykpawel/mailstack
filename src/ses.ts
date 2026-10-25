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
    retries: 0,
  });

  const payload = {
    ...(env.SES_CONFIGURATION_SET && params.messageId ? {
      ConfigurationSetName: env.SES_CONFIGURATION_SET,
      EmailTags: [{ Name: "ms_id", Value: params.messageId }, { Name: "ms_brand", Value: params.brand }],
    } : {}),
    FromEmailAddress: params.from,
    Destination: { ToAddresses: params.to },
    ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
    Content: {
      Simple: {
        ...(params.attachments?.length ? { Attachments: params.attachments.map(file => ({
          RawContent: file.contentBase64, FileName: file.filename, ContentType: file.contentType,
          ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64",
        })) } : {}),
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

  const raw = await res.text().catch(error => { if (res.ok) throw error; return ""; });
  let response: unknown = raw;
  try { response = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const type = response && typeof response === "object" && "__type" in response ? response.__type : undefined;
    console.error(JSON.stringify({ status: res.status, ...(typeof type === "string" ? { __type: type } : {}) }));
  }
  const messageId = response && typeof response === "object" && "MessageId" in response && typeof response.MessageId === "string"
    ? response.MessageId : undefined;
  return { ok: res.ok, status: res.status, messageId, response };
}
