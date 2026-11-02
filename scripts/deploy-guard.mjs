import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.ts";

export function checkRepository(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git("status", "--porcelain", "--untracked-files=all")) {
    throw new Error("Working tree must be clean before deploy.");
  }
  try {
    git("fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main");
  } catch {
    throw new Error("Cannot fetch origin/main; deploy refused.");
  }
  const sha = git("rev-parse", "HEAD");
  const main = git("rev-parse", "refs/remotes/origin/main");
  if (sha !== main) {
    const tagged = git("tag", "--points-at", sha);
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", sha, main], { cwd });
    if (!tagged || ancestor.status !== 0) {
      throw new Error("HEAD must equal origin/main or be a tag reachable from origin/main.");
    }
  }
  return sha;
}

/** Core commit, plus the Mailstack Pro commit when MAILSTACK_PRO_PATH is configured. */
export function checkRepositories(cwd = process.cwd(), proPath = loadEnv(cwd).MAILSTACK_PRO_PATH?.trim()) {
  return { sha: checkRepository(cwd), pro: proPath ? checkRepository(proPath) : undefined };
}

export async function deploy({
  cwd = process.cwd(), healthUrl = process.env.MAILSTACK_HEALTH_URL, proPath,
  runWrangler = (args) => {
    const result = spawnSync("wrangler", args, { cwd, stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error("Wrangler deploy failed.");
  },
  fetchHealth = fetch, log = console.log,
} = {}) {
  const { sha, pro } = checkRepositories(cwd, proPath);
  await runWrangler(["deploy", "--var", `BUILD_COMMIT:${sha}`, ...(pro ? ["--var", `BUILD_PRO_COMMIT:${pro}`] : [])]);
  if (!healthUrl) {
    log("MAILSTACK_HEALTH_URL is unset; skipping post-deploy health check.");
    return;
  }
  const response = await fetchHealth(healthUrl, {
    cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Health check failed: HTTP ${response.status}.`);
  const health = await response.json();
  if (health?.commit !== sha || health?.proCommit !== pro) throw new Error("Health commit does not match HEAD.");
  log(`Health commit verified: ${sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) checkRepositories();
    else if (args.length === 1 && args[0] === "--deploy") await deploy();
    else throw new Error("Usage: node scripts/deploy-guard.mjs [--deploy]");
  } catch (error) {
    console.error(`[deploy-guard] ${error.message}`);
    process.exitCode = 1;
  }
}
