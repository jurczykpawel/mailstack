import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { handleSend } from "../src/send";
import { escapeHtml } from "../src/templates/layout";
import type { Env, SendDeps, SendParams } from "../src/types";
import { memoryStore } from "./store-fixture";

const env: Env = {
  SES_REGION: "eu-west-1", SES_ACCESS_KEY_ID: "test", SES_SECRET_ACCESS_KEY: "test",
  TURNSTILE_SECRET: "test", API_KEY: "content-test-token", ALTCHA_HMAC_KEY: "test",
};

async function send(raw: string, trusted: boolean) {
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
  const deps: SendDeps = {
    store: memoryStore(), sendEmail, verifyTurnstile: async () => true, verifyAltcha: async () => true,
    now: () => new Date("2026-06-10T12:00:00Z"),
  };
  const response = await handleSend(new Request("https://mail.example/v1/send", {
    method: "POST", body: raw,
    headers: { "content-type": "application/json", origin: "https://acme.example",
      ...(trusted ? { authorization: `Bearer ${env.API_KEY}` } : {}) },
  }), env, deps);
  return { response, sendEmail, params: sendEmail.mock.calls[0]?.[1] };
}

describe.each([false, true])("content boundaries (trusted=%s)", (trusted) => {
  it.each([4998, 4999, 5000])("caps %i ASCII units followed by emoji as complete characters", async (count) => {
    for (const array of [false, true]) {
      const input = "a".repeat(count) + "🐢";
      const expected = "a".repeat(count) + (count === 4998 ? "🐢" : "");
      const { response, params } = await send(JSON.stringify({
        brand: "acme", autoreply: false, qaField: array ? [input] : input,
      }), trusted);
      expect(response.status).toBe(200);
      expect(params!.html).toContain(`>${expected}</td>`);
      expect(params!.text).toContain(`QaField: ${expected}\n`);
      for (const output of [params!.html, params!.text]) {
        expect(output).toBe(output.toWellFormed());
        expect(output).not.toContain("�");
      }
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
      const mime = await transport.sendMail({ ...params, textEncoding: "base64" });
      const parts = mime.message.toString().split(/\r?\n--[^\r\n]+/)
        .filter((part: string) => /Content-Transfer-Encoding: base64/.test(part))
        .map((part: string) => Buffer.from(part.split(/\r?\n\r?\n/)[1].trim(), "base64").toString("utf8"));
      expect(parts).toHaveLength(2);
      expect(parts.every((part: string) => part.includes(expected) && !part.includes("�"))).toBe(true);
    }
  });

  it("keeps END4 at the limit and applies the cap after joining arrays", async () => {
    for (const value of ["a".repeat(4996) + "END4", ["a".repeat(4994), "END4"], ["a".repeat(4997), "🐢"]]) {
      const expected = typeof value === "string" ? value : value.join("\n\n").replace(/🐢$/, "");
      const { response, params } = await send(JSON.stringify({ brand: "acme", qaField: value }), trusted);
      expect(response.status).toBe(200);
      expect(params!.text).toContain(`QaField: ${expected}\n`);
      expect(params!.html).toBe(params!.html.toWellFormed());
    }
  });

  it("renders all own string fields from raw JSON", async () => {
    const raw = '{"brand":"acme","template":"contact","to":"buyer@acme.example","__proto__":"PROTO <b>VALUE</b>","qaField":"ORDINARY VALUE","constructor":"CTOR VALUE","hasOwnProperty":"OWN VALUE","message":"Message END4"}';
    expect(Object.hasOwn(JSON.parse(raw), "__proto__")).toBe(true);
    const originalKeys = Object.getOwnPropertyNames(Object.prototype);
    const { response, params } = await send(raw, trusted);
    expect(response.status).toBe(200);
    for (const value of ["PROTO <b>VALUE</b>", "ORDINARY VALUE", "CTOR VALUE", "OWN VALUE", "Message END4"]) {
      expect(params!.text).toContain(value);
      expect(params!.html).toContain(escapeHtml(value));
    }
    expect(params!.html).not.toContain("<b>VALUE</b>");
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(originalKeys);
    expect({}.constructor).toBe(Object);
  });

  it("counts unusual own names within the same forty-field limit", async () => {
    const body = JSON.parse('{"brand":"acme","__proto__":"FIRST VALUE","constructor":"SECOND VALUE","hasOwnProperty":"THIRD VALUE"}');
    for (let i = 3; i <= 40; i++) body[`field${i}`] = `VALUE-${i}-END4`;
    const { response, params } = await send(JSON.stringify(body), trusted);
    expect(response.status).toBe(200);
    for (const value of ["FIRST VALUE", "SECOND VALUE", "THIRD VALUE", "VALUE-39-END4"]) expect(params!.text).toContain(value);
    expect(params!.text).not.toContain("VALUE-40-END4");
  });

  it("still rejects bodies above 64 KiB before sending", async () => {
    const { response, sendEmail } = await send(JSON.stringify({ brand: "acme", message: "Ż".repeat(32768) }), trusted);
    expect(response.status).toBe(413);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
