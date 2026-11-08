// Rotates the SES access key of each configured Worker target: create, verify, swap Worker secrets,
// verify end to end, deactivate the previous key; inactive keys unused for `inactiveDays` are deleted.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

export interface Target {
  name: string; iamUser: string; region: string; from: string; apiUrl: string; brand: string;
  sendTokenEnv: string; recipient?: string;
  cloudflare: { accountId: string; worker: string; tokenEnv: string };
}
export interface RotationConfig { ageDays?: number; inactiveDays?: number; ntfyUrlEnv?: string; targets: Target[] }
export interface AccessKey { id: string; active: boolean; created: Date; lastUsed?: Date }
export interface Credential { id: string; secret: string }
export type Versions = { version_id: string; percentage: number }[];
export interface Deps {
  listKeys(user: string): Promise<AccessKey[]>;
  createKey(user: string): Promise<Credential>;
  setActive(user: string, id: string, active: boolean): Promise<void>;
  deleteKey(user: string, id: string): Promise<void>;
  probeSes(target: Target, credential: Credential): Promise<boolean>;
  deployedVersions(target: Target): Promise<Versions>;
  putSecrets(target: Target, credential: Credential): Promise<void>;
  restoreVersions(target: Target, versions: Versions): Promise<void>;
  sendThroughWorker(target: Target): Promise<boolean>;
  notify(message: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}
export interface Outcome { target: string; status: "skipped" | "rotated" | "failed" | "not-run"; detail: string }

const DAY = 86_400_000;
const tail = (id: string) => `…${id.slice(-4)}`;

async function retry(deps: Deps, attempts: number, delayMs: number, check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i) await deps.sleep(delayMs);
    try { if (await check()) return true; } catch { /* treated as a failed attempt */ }
  }
  return false;
}

/** Runs every cleanup/undo step and collects failures instead of stopping at the first one. */
async function undo(steps: [string, () => Promise<unknown>][]): Promise<string> {
  const failed: string[] = [];
  for (const [label, step] of steps) { try { await step(); } catch { failed.push(label); } }
  return failed.length ? `; ROLLBACK INCOMPLETE: ${failed.join(", ")}` : "; rolled back";
}

export async function rotateTarget(target: Target, deps: Deps, config: RotationConfig, force: boolean): Promise<Outcome> {
  const ageDays = config.ageDays ?? 75, inactiveDays = config.inactiveDays ?? 7, now = deps.now().getTime();
  const out = (status: Outcome["status"], detail: string): Outcome => ({ target: target.name, status, detail });
  for (const key of await deps.listKeys(target.iamUser)) {
    const idleSince = (key.lastUsed ?? key.created).getTime();
    if (!key.active && now - idleSince >= inactiveDays * DAY) await deps.deleteKey(target.iamUser, key.id);
  }
  const keys = await deps.listKeys(target.iamUser);
  const active = keys.filter(key => key.active);
  if (!active.length) return out("failed", "no active key");
  const youngest = Math.min(...active.map(key => (now - key.created.getTime()) / DAY));
  if (!force && youngest < ageDays) return out("skipped", `key age ${Math.floor(youngest)}d < ${ageDays}d`);
  if (keys.length >= 2) return out("failed", `user already has ${keys.length} keys (IAM limit 2); rotation stopped`);

  const fresh = await deps.createKey(target.iamUser);
  const dropFresh: [string, () => Promise<unknown>] = ["delete new key", () => deps.deleteKey(target.iamUser, fresh.id)];
  if (!await retry(deps, 6, 10_000, () => deps.probeSes(target, fresh)))
    return out("failed", `new key ${tail(fresh.id)} failed the direct SES check${await undo([dropFresh])}`);

  const previous = await deps.deployedVersions(target);
  const restoreWorker: [string, () => Promise<unknown>] = ["restore Worker version", () => deps.restoreVersions(target, previous)];
  try { await deps.putSecrets(target, fresh); }
  catch { return out("failed", `setting Worker secrets failed${await undo([restoreWorker, dropFresh])}`); }
  await deps.sleep(20_000);
  if (!await retry(deps, 6, 20_000, () => deps.sendThroughWorker(target)))
    return out("failed", `Worker send failed after the secret change${await undo([restoreWorker, dropFresh])}`);

  // The old key stays valid until here, so only a send after deactivation proves the Worker uses the new key.
  for (const key of active) await deps.setActive(target.iamUser, key.id, false);
  if (!await retry(deps, 6, 20_000, () => deps.sendThroughWorker(target))) {
    const reactivate = active.map(key => [`reactivate ${tail(key.id)}`, () => deps.setActive(target.iamUser, key.id, true)] as [string, () => Promise<unknown>]);
    return out("failed", `Worker send failed with the old key deactivated${await undo([...reactivate, restoreWorker, dropFresh])}`);
  }
  return out("rotated", `${active.map(key => tail(key.id)).join(",")} → ${tail(fresh.id)}`);
}

/** Targets run in order; a failure stops every later target (staging gates production). */
export async function rotateAll(config: RotationConfig, deps: Deps, options: { force?: boolean; only?: string } = {}): Promise<Outcome[]> {
  const targets = config.targets.filter(target => !options.only || target.name === options.only);
  if (options.only && !targets.length) throw new Error(`unknown target ${options.only}`);
  const outcomes: Outcome[] = [];
  for (const target of targets) {
    if (outcomes.some(outcome => outcome.status === "failed")) { outcomes.push({ target: target.name, status: "not-run", detail: "earlier target failed" }); continue; }
    try { outcomes.push(await rotateTarget(target, deps, config, !!options.force)); }
    catch (error) { outcomes.push({ target: target.name, status: "failed", detail: `unexpected error: ${(error as Error).message}` }); }
  }
  if (outcomes.some(outcome => outcome.status !== "skipped")) {
    const failed = outcomes.some(outcome => outcome.status === "failed");
    const text = `SES key rotation ${failed ? "FAILED" : "OK"}: ${outcomes.map(o => `${o.target} ${o.status} (${o.detail})`).join("; ")}`;
    try { await deps.notify(text); } catch { console.error("ntfy notification failed"); }
  }
  return outcomes;
}

// ---- production dependencies ----
const xml = (body: string, tag: string) => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export function liveDeps(config: RotationConfig): Deps {
  const iam = new AwsClient({ accessKeyId: env("ROTATOR_AWS_ACCESS_KEY_ID"), secretAccessKey: env("ROTATOR_AWS_SECRET_ACCESS_KEY"), service: "iam", region: "us-east-1" });
  const iamCall = async (params: Record<string, string>) => {
    const response = await iam.fetch("https://iam.amazonaws.com/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Version: "2010-05-08", ...params }).toString() });
    const body = await response.text();
    if (!response.ok) throw new Error(`IAM ${params.Action} ${response.status} ${xml(body, "Code") ?? ""}`);
    return body;
  };
  const cloudflare = async (target: Target, path: string, init: RequestInit = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${target.cloudflare.accountId}/workers/scripts/${target.cloudflare.worker}${path}`,
      { ...init, headers: { authorization: `Bearer ${env(target.cloudflare.tokenEnv)}`, "content-type": "application/json", ...init.headers } });
    const body = await response.json().catch(() => ({})) as { success?: boolean; result?: unknown; errors?: { code: number }[] };
    if (!response.ok || !body.success) throw new Error(`Cloudflare ${path} ${response.status} ${(body.errors ?? []).map(e => e.code).join(",")}`);
    return body.result;
  };
  const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  return {
    async listKeys(user) {
      const body = await iamCall({ Action: "ListAccessKeys", UserName: user });
      return Promise.all([...body.matchAll(/<member>([\s\S]*?)<\/member>/g)].map(async ([, member]) => {
        const id = xml(member, "AccessKeyId")!;
        const lastUsed = xml(await iamCall({ Action: "GetAccessKeyLastUsed", AccessKeyId: id }), "LastUsedDate");
        return { id, active: xml(member, "Status") === "Active", created: new Date(xml(member, "CreateDate")!), lastUsed: lastUsed ? new Date(lastUsed) : undefined };
      }));
    },
    async createKey(user) {
      const body = await iamCall({ Action: "CreateAccessKey", UserName: user });
      return { id: xml(body, "AccessKeyId")!, secret: xml(body, "SecretAccessKey")! };
    },
    async setActive(user, id, active) { await iamCall({ Action: "UpdateAccessKey", UserName: user, AccessKeyId: id, Status: active ? "Active" : "Inactive" }); },
    async deleteKey(user, id) { await iamCall({ Action: "DeleteAccessKey", UserName: user, AccessKeyId: id }); },
    async probeSes(target, credential) {
      const ses = new AwsClient({ accessKeyId: credential.id, secretAccessKey: credential.secret, service: "ses", region: target.region });
      const response = await ses.fetch(`https://email.${target.region}.amazonaws.com/v2/email/outbound-emails`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        FromEmailAddress: target.from, Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Content: { Simple: { Subject: { Data: "SES key rotation check" }, Body: { Text: { Data: "Automated key check." } } } } }) });
      return response.ok;
    },
    async deployedVersions(target) {
      const result = await cloudflare(target, "/deployments") as { deployments: { created_on: string; versions: Versions }[] };
      const latest = [...result.deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0];
      if (!latest) throw new Error("no deployment");
      return latest.versions;
    },
    async putSecrets(target, credential) {
      const secrets = { SES_ACCESS_KEY_ID: credential.id, SES_SECRET_ACCESS_KEY: credential.secret };
      await cloudflare(target, "/secrets-bulk", { method: "PATCH", headers: { "content-type": "application/merge-patch+json" },
        body: JSON.stringify({ secrets: Object.fromEntries(Object.entries(secrets).map(([name, text]) => [name, { name, text, type: "secret_text" }])) }) });
    },
    async restoreVersions(target, versions) {
      await cloudflare(target, "/deployments?force=true", { method: "POST", body: JSON.stringify({ strategy: "percentage", versions, annotations: { "workers/message": "SES key rotation rollback" } }) });
    },
    async sendThroughWorker(target) {
      const response = await fetch(new URL("/v1/send", target.apiUrl), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env(target.sendTokenEnv)}` },
        body: JSON.stringify({ brand: target.brand, template: "notice", heading: "SES key rotation check", paragraphs: "Automated delivery check.", ...target.recipient ? { to: target.recipient } : {} }) });
      const body = await response.json().catch(() => ({})) as { success?: boolean };
      return response.ok && body.success === true;
    },
    async notify(message) {
      if (!config.ntfyUrlEnv) return;
      const response = await fetch(env(config.ntfyUrlEnv), { method: "POST", headers: { Title: "Mailstack SES key rotation" }, body: message });
      if (!response.ok) throw new Error(`ntfy ${response.status}`);
    },
    sleep,
    now: () => new Date(),
  };
}

async function main(argv: string[]) {
  const force = argv.includes("--force"), onlyAt = argv.indexOf("--only"), only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined;
  const file = process.env.SES_ROTATION_CONFIG;
  if (!file) throw new Error("set SES_ROTATION_CONFIG to the targets JSON file");
  if (force && !only) throw new Error("--force requires --only <target>");
  const config = JSON.parse(readFileSync(file, "utf8")) as RotationConfig;
  const outcomes = await rotateAll(config, liveDeps(config), { force, only });
  for (const outcome of outcomes) console.log(`${outcome.target}: ${outcome.status} (${outcome.detail})`);
  if (outcomes.some(outcome => outcome.status === "failed")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
