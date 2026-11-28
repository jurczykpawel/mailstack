#!/usr/bin/env node
// `npm run init`: one brand, one contact form, deployed to Cloudflare Workers + D1. Asks for the minimum,
// creates the databases, configuration, secrets and Worker, and prints the HTML form. Works without git.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = /^[^\s@<>"]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Brand id and Worker name from the brand name: lowercase ASCII, digits and hyphens. */
export function slug(name) {
  const id = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ł/gi, "l").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return id || "form";
}

/** The site's origin (scheme + host[:port]) from what the user typed. */
export function origin(site) {
  const url = new URL(/^https?:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`);
  return url.origin;
}

/** Minimal validated configuration: one brand, ALTCHA, the chosen sender, no webhook sources, log level as chosen. */
export function buildConfig({ name, id, site, inbox, from, sender, level }) {
  const host = new URL(site).hostname;
  return {
    version: 1,
    sender: { type: sender },
    cloudflare: { plan: "free" },
    sources: {},
    brands: { [id]: {
      id, name, from: `${name} <${from}>`, to: [inbox], allowedOrigins: [site, ...host.startsWith("www.") ? [] : [site.replace("://", "://www.")]],
      subjectPrefix: "New message from", captcha: "altcha", autoReply: false, theme: { accent: "#2563eb", siteUrl: site },
    } },
    logging: {
      defaults: { level, contentDays: 30, metaDays: 90, requireLog: false, resend: "off", alertOn: [], includeSecrets: false },
      ceilings: { contentDays: 90, metaDays: 400, auditDays: 400 }, patterns: [], brands: {},
    },
  };
}

/** Database id from `wrangler d1 create` output (TOML or JSON snippet). */
export function parseD1Id(output) {
  const match = output.match(/database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/);
  if (!match) throw new Error("Could not read the database id from wrangler d1 create.");
  return match[1];
}

/** The deployed workers.dev URL from `wrangler deploy` output. */
export const parseWorkerUrl = (output) => output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];

/** A ready contact form for the brand: ALTCHA widget plus a small fetch, since /v1/send takes JSON. */
export function formSnippet(api, brand) {
  return `<form id="contact-form">
  <input name="name" placeholder="Name" required>
  <input name="email" type="email" placeholder="Email" required>
  <textarea name="message" placeholder="Message" required></textarea>
  <input name="botcheck" type="text" style="display:none" tabindex="-1" autocomplete="off">
  <altcha-widget challengeurl="${api}/altcha/challenge?brand=${brand}"></altcha-widget>
  <button type="submit">Send</button>
  <p id="contact-status" role="status"></p>
</form>
<script async defer src="https://cdn.jsdelivr.net/npm/altcha@2.3.0/dist/altcha.min.js" type="module"></script>
<script>
document.getElementById("contact-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, status = document.getElementById("contact-status");
  const body = Object.fromEntries(new FormData(form));
  const res = await fetch("${api}/v1/send", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, brand: "${brand}" }) }).catch(() => null);
  const data = res && await res.json().catch(() => null);
  status.textContent = data?.success ? "Thank you, message sent." : "Sending failed, please try again.";
  if (data?.success) form.reset();
  form.querySelector("altcha-widget")?.reset?.(); // every attempt needs a new challenge
});
</script>`;
}

const wrangler = (args, { input, capture = true } = {}) => {
  const result = spawnSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args], {
    cwd: root, input, encoding: "utf8", stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"] });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  return { ok: result.status === 0, out: result.stdout ?? "" };
};
/** Runs a command showing its output live and returns it for parsing. */
const tee = (cmd, args) => new Promise((done) => {
  const child = spawn(cmd, args, { cwd: root, stdio: ["inherit", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; process.stdout.write(chunk); });
  child.on("close", (code) => done({ ok: code === 0, out }));
});
const must = (result, what) => { if (!result.ok) throw new Error(`${what} failed; see the wrangler output above.`); return result.out; };

async function main() {
  if (!existsSync(join(root, "node_modules/wrangler"))) throw new Error("Run npm ci (or npm install) in this folder first.");
  if (existsSync(join(root, ".env"))) throw new Error(".env already exists: this folder is set up. Edit .env and MAILSTACK_CONFIG, then run npm run release.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, fallback, check = (v) => v.length > 0) => {
    for (;;) {
      const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback || "";
      if (check(answer)) return answer;
      console.log("  Please enter a valid value.");
    }
  };
  try {
    console.log("Mailstack setup: a contact form on your domain, sent from a Cloudflare Worker.\n");
    const who = wrangler(["whoami"]);
    if (!who.ok || /not authenticated/i.test(who.out)) must(wrangler(["login"], { capture: false }), "wrangler login");
    const name = await ask("Brand or site name (shown as the sender name)");
    const site = origin(await ask("Website address where the form lives (e.g. https://example.com)", "", (v) => { try { origin(v); return true; } catch { return false; } }));
    const inbox = await ask("Inbox that receives the form messages", "", (v) => EMAIL.test(v));
    const domain = new URL(site).hostname.replace(/^www\./, "");
    const sender = (await ask("Sender: 1 = Cloudflare Email Service (free, domain on Cloudflare), 2 = Amazon SES", "1", (v) => v === "1" || v === "2")) === "1" ? "cloudflare" : "ses";
    const from = await ask(`From address (a domain ${sender === "ses" ? "verified in SES" : "on Cloudflare"})`, `no-reply@${domain}`, (v) => EMAIL.test(v));
    console.log("Log level: none keeps no message records and needs no encryption keys (recommended for a contact form);\n  meta records delivery metadata, encrypted, and needs a key file with an offline copy.");
    const level = await ask("Log level (none/meta)", "none", (v) => v === "none" || v === "meta");
    const id = slug(name), worker = await ask("Cloudflare Worker name", `mailstack-${id}`, (v) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(v) && v !== "mailstack");
    const configDir = join(homedir(), ".config", "mailstack"), configPath = join(configDir, `${worker}.json`);
    if (existsSync(configPath)) throw new Error(`${configPath} already exists; choose another Worker name.`);

    const secrets = { API_KEY: randomBytes(32).toString("hex"), ALTCHA_HMAC_KEY: randomBytes(32).toString("hex") };
    if (sender === "ses") {
      console.log("SES needs an IAM key allowed to call ses:SendEmail, and the From address verified in that region.");
      secrets.SES_ACCESS_KEY_ID = await ask("SES access key id");
      secrets.SES_SECRET_ACCESS_KEY = await ask("SES secret access key");
    } else {
      console.log(`\nCloudflare Email Service sends from ${domain} once the domain is enabled for sending in this account.`);
      if ((await ask(`Enable Email Sending for ${new URL(`https://${from.split("@")[1]}`).hostname} now (adds its SPF/DKIM DNS records)? y/n`, "y")).toLowerCase() === "y"
        && !wrangler(["email", "sending", "enable", from.split("@")[1]]).ok)
        console.log("  Enable it in the dashboard instead: Compute & AI > Email Service > Onboard Domain.");
      console.log(`On the Workers Free plan messages go only to verified destination addresses. Adding ${inbox} (Cloudflare emails a confirmation link):`);
      const added = wrangler(["email", "routing", "addresses", "create", inbox]).ok;
      if (!added) console.log(`  Not added here (see above). If ${inbox} is not verified yet, add it in the dashboard: Email Routing > Destination addresses.`);
      await ask(added ? `Click the link Cloudflare sent to ${inbox}, then press Enter` : `Press Enter once ${inbox} is a verified destination address`, "ok", () => true);
    }

    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const d1 = parseD1Id(must(wrangler(["d1", "create", worker]), "Creating the database"));
    const preview = parseD1Id(must(wrangler(["d1", "create", `${worker}-preview`]), "Creating the preview database"));
    writeFileSync(configPath, JSON.stringify(buildConfig({ name, id, site, inbox, from, sender, level }), null, 2) + "\n", { mode: 0o600 });
    if (level !== "none") {
      const keyFile = join(configDir, `${worker}-content-private.json`);
      console.log(`Creating the encryption key file ${keyFile}; copy it to offline storage when asked.`);
      const keys = spawnSync(process.execPath, [join(root, "scripts/keys.mjs"), "init", keyFile], { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
      if (keys.status !== 0) throw new Error("Key setup did not finish; rerun npm run init after removing .env and the files it names.");
      for (const line of keys.stdout.trim().split("\n")) {
        const [, key, value] = line.match(/^([A-Z_]+)='(.*)'$/) ?? [];
        if (key === "CONTENT_PUBLIC_KEYS" || key === "INDEX_KEYS") secrets[key] = value;
      }
    }
    writeFileSync(join(root, ".env"), [`MAILSTACK_CONFIG=${configPath}`, `MAILSTACK_WORKER_NAME=${worker}`,
      `MAILSTACK_D1_ID=${d1}`, `MAILSTACK_D1_PREVIEW_ID=${preview}`, ""].join("\n"), { mode: 0o600 });

    console.log("\nDeploying (setup, database schema, Worker)...");
    const release = await tee("npm", ["run", "release"]);
    if (!release.ok) throw new Error("npm run release failed; fix the reported problem and run npm run release again.");
    const dir = mkdtempSync(join(tmpdir(), "mailstack-secrets-")), file = join(dir, "secrets.json");
    try {
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
      must(wrangler(["secret", "bulk", file, "--name", worker]), "Uploading the secrets");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const keyPath = join(configDir, `${worker}.api-key`);
    writeFileSync(keyPath, `${secrets.API_KEY}\n`, { mode: 0o600 }); chmodSync(keyPath, 0o600);

    const api = parseWorkerUrl(release.out) ?? `https://${worker}.<your-subdomain>.workers.dev`;
    const health = await fetch(`${api}/health`).then((r) => r.json()).catch(() => undefined);
    console.log(`\nDone. API: ${api} (health: ${health?.ok ? "ok" : "not reachable yet, retry in a minute"})`);
    console.log(`Configuration: ${configPath}. Trusted API key (server-to-server only): ${keyPath}.`);
    console.log(`\nPaste this form into a page on ${site}:\n\n${formSnippet(api, id)}\n`);
  } finally { rl.close(); }
}

if (import.meta.main) await main().catch((error) => { console.error(`[init] ${error.message}`); process.exitCode = 1; });
