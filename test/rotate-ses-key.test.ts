import { describe, expect, it } from "vitest";
import { rotateAll, type AccessKey, type Deps, type RotationConfig, type Target } from "../scripts/rotate-ses-key.ts";

const NOW = new Date("2026-11-08T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const target = (name: string): Target => ({
  name, iamUser: `${name}-ses`, region: "eu-west-1", from: "no-reply@example.com", apiUrl: "https://mail.example.com", brand: "acme",
  sendTokenEnv: "SEND", cloudflare: { accountId: "acct", worker: name, tokenEnv: "CF" },
});
const config: RotationConfig = { targets: [target("staging"), target("production")] };

function fake(keys: Record<string, AccessKey[]>, behaviour: { probe?: boolean; sends?: boolean[]; putFails?: boolean } = {}) {
  const calls: string[] = [], notes: string[] = [];
  const sends = [...behaviour.sends ?? []];
  let counter = 0;
  const deps: Deps = {
    listKeys: async user => (keys[user] ?? []).map(key => ({ ...key })),
    createKey: async user => { const id = `AKIANEW${++counter}`; keys[user].push({ id, active: true, created: NOW }); calls.push(`create ${user}`); return { id, secret: "s" }; },
    setActive: async (user, id, active) => { keys[user].find(key => key.id === id)!.active = active; calls.push(`${active ? "activate" : "deactivate"} ${id}`); },
    deleteKey: async (user, id) => { keys[user] = keys[user].filter(key => key.id !== id); calls.push(`delete ${id}`); },
    probeSes: async () => behaviour.probe ?? true,
    deployedVersions: async t => [{ version_id: `${t.name}-v1`, percentage: 100 }],
    putSecrets: async t => { if (behaviour.putFails) throw new Error("cf"); calls.push(`secrets ${t.name}`); },
    restoreVersions: async (t, versions) => { calls.push(`restore ${t.name} ${versions[0].version_id}`); },
    sendThroughWorker: async () => sends.length ? sends.shift()! : true,
    notify: async message => { notes.push(message); },
    sleep: async () => {},
    now: () => NOW,
  };
  return { deps, calls, notes, keys };
}

describe("SES key rotation", () => {
  it("skips fresh keys silently and deletes inactive keys idle for seven days", async () => {
    const f = fake({
      "staging-ses": [{ id: "AKIAOLD1", active: true, created: daysAgo(10) }, { id: "AKIAIDLE", active: false, created: daysAgo(90), lastUsed: daysAgo(8) }],
      "production-ses": [{ id: "AKIAPROD", active: true, created: daysAgo(74) }, { id: "AKIARECENT", active: false, created: daysAgo(90), lastUsed: daysAgo(6) }],
    });
    const outcomes = await rotateAll(config, f.deps);
    expect(outcomes.map(o => o.status)).toEqual(["skipped", "skipped"]);
    expect(f.calls).toEqual(["delete AKIAIDLE"]);
    expect(f.notes).toEqual([]);
  });

  it("rotates a key aged 75 days: secrets, verification, then deactivation of the old key", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAFRESH", active: true, created: daysAgo(3) }], "production-ses": [{ id: "AKIAPROD", active: true, created: daysAgo(150) }] });
    const outcomes = await rotateAll(config, f.deps);
    expect(outcomes.map(o => o.status)).toEqual(["skipped", "rotated"]);
    expect(f.calls).toEqual(["create production-ses", "secrets production", "deactivate AKIAPROD"]);
    expect(f.keys["production-ses"].map(k => [k.id, k.active])).toEqual([["AKIAPROD", false], ["AKIANEW1", true]]);
    expect(f.notes[0]).toMatch(/^SES key rotation OK: .*production rotated \(…PROD → …NEW1\)/);
    expect(f.notes[0]).not.toContain('"s"');
  });

  it("force rotates a fresh key of the selected target only", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAFRESH", active: true, created: daysAgo(1) }], "production-ses": [{ id: "AKIAPROD", active: true, created: daysAgo(150) }] });
    const outcomes = await rotateAll(config, f.deps, { force: true, only: "staging" });
    expect(outcomes).toEqual([expect.objectContaining({ target: "staging", status: "rotated" })]);
    expect(f.calls).not.toContain("create production-ses");
  });

  it("stops with an alarm when two keys remain after cleanup", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAA", active: true, created: daysAgo(80) }, { id: "AKIAB", active: false, created: daysAgo(80), lastUsed: daysAgo(2) }], "production-ses": [{ id: "AKIAPROD", active: true, created: daysAgo(150) }] });
    const outcomes = await rotateAll(config, f.deps);
    expect(outcomes.map(o => o.status)).toEqual(["failed", "not-run"]);
    expect(outcomes[0].detail).toMatch(/IAM limit 2/);
    expect(f.calls).toEqual([]);
    expect(f.notes[0]).toMatch(/^SES key rotation FAILED/);
  });

  it("deletes the new key when the direct SES check fails and skips production", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAOLD", active: true, created: daysAgo(80) }], "production-ses": [{ id: "AKIAPROD", active: true, created: daysAgo(150) }] }, { probe: false });
    const outcomes = await rotateAll(config, f.deps);
    expect(outcomes.map(o => o.status)).toEqual(["failed", "not-run"]);
    expect(f.calls).toEqual(["create staging-ses", "delete AKIANEW1"]);
    expect(f.keys["staging-ses"]).toEqual([expect.objectContaining({ id: "AKIAOLD", active: true })]);
  });

  it("restores the previous Worker version and deletes the new key when the Worker send fails", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAOLD", active: true, created: daysAgo(80) }], "production-ses": [] }, { sends: Array(6).fill(false) });
    const [outcome] = await rotateAll(config, f.deps, { only: "staging" });
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toMatch(/rolled back$/);
    expect(f.calls).toEqual(["create staging-ses", "secrets staging", "restore staging staging-v1", "delete AKIANEW1"]);
  });

  it("reactivates the old key and rolls back when sends fail after deactivation", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAOLD", active: true, created: daysAgo(80) }], "production-ses": [] }, { sends: [true, ...Array(6).fill(false)] });
    const [outcome] = await rotateAll(config, f.deps, { only: "staging" });
    expect(outcome.status).toBe("failed");
    expect(f.calls).toEqual(["create staging-ses", "secrets staging", "deactivate AKIAOLD", "activate AKIAOLD", "restore staging staging-v1", "delete AKIANEW1"]);
  });

  it("tolerates propagation: a later Worker attempt succeeds without rollback", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAOLD", active: true, created: daysAgo(80) }], "production-ses": [] }, { sends: [false, false, true, false, true] });
    const [outcome] = await rotateAll(config, f.deps, { only: "staging" });
    expect(outcome.status).toBe("rotated");
  });

  it("rolls back when setting Worker secrets fails", async () => {
    const f = fake({ "staging-ses": [{ id: "AKIAOLD", active: true, created: daysAgo(80) }], "production-ses": [] }, { putFails: true });
    const [outcome] = await rotateAll(config, f.deps, { only: "staging" });
    expect(outcome.status).toBe("failed");
    expect(f.calls).toEqual(["create staging-ses", "restore staging staging-v1", "delete AKIANEW1"]);
  });

  it("rejects an unknown target", async () => {
    await expect(rotateAll(config, fake({}).deps, { only: "nope" })).rejects.toThrow(/unknown target/);
  });
});
