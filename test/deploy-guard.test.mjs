import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRepository, deploy } from "../scripts/deploy-guard.mjs";

let root, cwd, origin, peer;
const script = resolve("scripts/deploy-guard.mjs");
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (dir, text) => {
  writeFileSync(join(dir, "file"), text);
  git(dir, "add", "file");
  git(dir, "commit", "-m", text);
  return git(dir, "rev-parse", "HEAD");
};
const identity = (dir) => {
  git(dir, "config", "user.name", "Demo");
  git(dir, "config", "user.email", "demo@example.com");
  git(dir, "config", "commit.gpgsign", "false");
};
beforeEach(() => {
  root = mkdtempSync(resolve("node_modules/.deploy-guard-"));
  cwd = join(root, "work"); origin = join(root, "origin"); peer = join(root, "peer");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "main"); identity(cwd);
  commit(cwd, "initial");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "-u", "origin", "main");
  git(root, "clone", origin, peer); identity(peer);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("deploy repository", () => {
  it("accepts the current origin/main commit", () => {
    expect(checkRepository(cwd)).toBe(git(cwd, "rev-parse", "HEAD"));
  });
  it.each(["unstaged", "staged", "untracked"])("rejects %s changes", (kind) => {
    writeFileSync(join(cwd, kind === "untracked" ? "extra" : "file"), "changed");
    if (kind === "staged") git(cwd, "add", "file");
    expect(() => checkRepository(cwd)).toThrow(/clean|dirty/i);
  });
  it("rejects HEAD ahead of origin/main", () => {
    commit(cwd, "local");
    expect(() => checkRepository(cwd)).toThrow(/origin\/main/);
  });
  it("fetches origin and rejects HEAD behind its current main", () => {
    commit(peer, "remote"); git(peer, "push", "origin", "main");
    expect(() => checkRepository(cwd)).toThrow(/origin\/main/);
    expect(git(cwd, "rev-parse", "origin/main")).toBe(git(peer, "rev-parse", "HEAD"));
  });
  it.each([false, true])("accepts a reachable tag (annotated: %s)", (annotated) => {
    git(cwd, "tag", ...(annotated ? ["-a", "-m", "release"] : []), "v1.0.0");
    commit(peer, "next"); git(peer, "push", "origin", "main");
    git(cwd, "checkout", "--detach", "v1.0.0");
    expect(checkRepository(cwd)).toBe(git(cwd, "rev-parse", "HEAD"));
  });
  it("rejects a tag outside origin/main history", () => {
    commit(cwd, "local"); git(cwd, "tag", "v2.0.0");
    expect(() => checkRepository(cwd)).toThrow(/origin\/main/);
  });
  it("rejects a missing origin", () => {
    git(cwd, "remote", "remove", "origin");
    expect(() => checkRepository(cwd)).toThrow(/fetch|origin/i);
  });
  it("rejects a failed fetch despite an existing tracking ref", () => {
    git(cwd, "remote", "set-url", "origin", join(root, "missing"));
    expect(() => checkRepository(cwd)).toThrow(/fetch/i);
  });
  it("rejects an origin with no main branch even with a stale tracking ref", () => {
    git(origin, "update-ref", "-d", "refs/heads/main");
    expect(() => checkRepository(cwd)).toThrow(/fetch|origin\/main/i);
  });
  it("exits nonzero through the command line on refusal", () => {
    commit(cwd, "local");
    const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/origin\/main/);
  });
});

describe("deploy execution", () => {
  const options = () => ({ cwd, healthUrl: "https://mail.example.com/health", runWrangler: vi.fn(), fetchHealth: vi.fn(), log: vi.fn() });
  it("passes HEAD to Wrangler and checks health after success", async () => {
    const opts = options(), sha = git(cwd, "rev-parse", "HEAD");
    opts.fetchHealth.mockImplementation(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("Invalid redirect value");
      return Response.json({ commit: sha });
    });
    await deploy(opts);
    expect(opts.runWrangler).toHaveBeenCalledWith(["deploy", "--var", `BUILD_COMMIT:${sha}`]);
    expect(opts.fetchHealth).toHaveBeenCalledWith(opts.healthUrl, expect.objectContaining({ cache: "no-store", redirect: "manual", signal: expect.any(AbortSignal) }));
    expect(opts.runWrangler.mock.invocationCallOrder[0]).toBeLessThan(opts.fetchHealth.mock.invocationCallOrder[0]);
  });
  it.each([300, 301, 302, 303, 304, 305, 306, 307, 308, 399, "opaqueredirect"])("rejects health response %s", async (status) => {
    const opts = options();
    const response = status === "opaqueredirect" ? Response.error() : new Response(null, { status });
    if (status === "opaqueredirect") Object.defineProperty(response, "type", { value: status });
    opts.fetchHealth.mockResolvedValue(response);
    await expect(deploy(opts)).rejects.toThrow(/Health check failed/);
    expect(opts.fetchHealth).toHaveBeenCalledOnce();
  });
  it("stops before Wrangler when repository checks fail", async () => {
    const opts = options(); commit(cwd, "local");
    await expect(deploy(opts)).rejects.toThrow();
    expect(opts.runWrangler).not.toHaveBeenCalled();
    expect(opts.fetchHealth).not.toHaveBeenCalled();
  });
  it("does not check health when Wrangler fails", async () => {
    const opts = options(); opts.runWrangler.mockImplementation(() => { throw new Error("Wrangler failed"); });
    await expect(deploy(opts)).rejects.toThrow(/Wrangler/);
    expect(opts.fetchHealth).not.toHaveBeenCalled();
  });
  it.each([{}, { commit: "other" }])("rejects health with commit %j", async (body) => {
    const opts = options(); opts.fetchHealth.mockResolvedValue(Response.json(body));
    await expect(deploy(opts)).rejects.toThrow(/commit/i);
  });
  it.each(["http", "json", "network"])("rejects a health %s failure", async (kind) => {
    const opts = options();
    if (kind === "network") opts.fetchHealth.mockRejectedValue(new Error("offline"));
    else opts.fetchHealth.mockResolvedValue(new Response("unavailable", { status: kind === "http" ? 503 : 200 }));
    await expect(deploy(opts)).rejects.toThrow();
  });
  it("explicitly reports a skipped health check without a URL", async () => {
    const opts = { ...options(), healthUrl: "" };
    await deploy(opts);
    expect(opts.runWrangler).toHaveBeenCalledOnce();
    expect(opts.fetchHealth).not.toHaveBeenCalled();
    expect(opts.log).toHaveBeenCalledWith(expect.stringMatching(/MAILSTACK_HEALTH_URL.*skip/i));
  });
  it("runs the guard before setup and wraps the deploy command", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.predeploy).toBe("node scripts/deploy-guard.mjs && npm run setup");
    expect(pkg.scripts.deploy).toBe("node scripts/deploy-guard.mjs --deploy");
  });
});
