// SPDX-License-Identifier: AGPL-3.0-only
// The Mac hub follows releases by itself. A launchd job runs this every 10 minutes: when the
// `release` branch on GitHub points at a new vX.Y.Z tag (CI moves it there only after the tag
// passed), check it out, `bun install`, restart the hub with a plain kickstart, and wait for
// /health. If the hub doesn't come back healthy, go back to the version it ran before. It never
// touches the tunnel, the brain, or a working copy with uncommitted changes. See docs/release.md.
//   bun scripts/deploy.ts run [--app <dir>] [--health <url>]   one pass (what launchd runs)
//   bun scripts/deploy.ts status                               the last pass (deploy.json)
//   bun scripts/deploy.ts hold | unhold                        stop or resume following releases
//   bun scripts/deploy.ts plist [--app <dir>] [--minutes <n>]  the launchd job, com.pocketbrain.update
// State: deploy.json in the config folder (~/.config/pocketbrain, or $PB_CONFIG_DIR); the hub's
// health probe turns a rollback, a block or a pass that stopped running into one alert.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { keysDir } from "../src/secrets";

export type Status = "deployed" | "current" | "rolled-back" | "down" | "blocked" | "held" | "error";
// unreleased_since: the oldest commit on main that the release branch doesn't have (null when level),
// so the hub's self-check can say a release is overdue. Absent when main couldn't be fetched.
export interface DeployState { status: Status; detail: string; version?: string; sha?: string; previous?: string; at?: string; unreleased_since?: string | null; checked_at: string }
export interface Effects {
  install(dir: string): boolean;
  restart(): boolean;
  healthy(): Promise<boolean>;
  log(line: string): void;
}

export const configDir = () => dirname(keysDir());
export const statePath = () => join(configDir(), "deploy.json");
const holdPath = () => join(configDir(), "deploy.hold");

export function readState(p = statePath()): DeployState | undefined {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}

function git(app: string, ...a: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", app, ...a], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.exitCode === 0 ? r.stdout : r.stderr).toString().trim() };
}

const semver = (t: string) => t.replace(/^v/, "").split(".").map(Number);
export function newestTag(tags: string[]): string | undefined {
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => {
    const x = semver(a), y = semver(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).at(-1);
}

const label = (app: string, sha: string) => newestTag(git(app, "tag", "--points-at", sha).out.split("\n")) ?? sha.slice(0, 7);

export async function deployOnce(o: { app: string; remote?: string; branch?: string; fx: Effects; state?: string; hold?: string; now?: () => Date }): Promise<DeployState> {
  const { app, fx } = o;
  const remote = o.remote ?? "origin", branch = o.branch ?? "release", file = o.state ?? statePath();
  const now = () => (o.now?.() ?? new Date()).toISOString();
  const last = readState(file);
  let lag: Pick<DeployState, "unreleased_since"> = {};
  const save = (s: Omit<DeployState, "checked_at">): DeployState => {
    const full = { ...s, ...lag, checked_at: now() };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(full, null, 2) + "\n");
    fx.log(`${full.checked_at} ${full.status}: ${full.detail}`);
    return full;
  };
  const keep = { version: last?.version, sha: last?.sha, previous: last?.previous, at: last?.at };

  if (existsSync(o.hold ?? holdPath())) return save({ ...keep, status: "held", detail: "on hold (bun scripts/deploy.ts unhold to follow releases again)" });
  const f = git(app, "fetch", "-q", "--tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
  if (!f.ok) return save({ ...keep, status: "error", detail: `fetch failed: ${f.out.split("\n")[0]}` });
  // How far main is ahead of the release branch; a failed fetch of main only leaves it out.
  if (git(app, "fetch", "-q", remote, `+refs/heads/main:refs/remotes/${remote}/main`).ok) {
    const ahead = git(app, "log", "--reverse", "--format=%cI", `refs/remotes/${remote}/${branch}..refs/remotes/${remote}/main`);
    if (ahead.ok) lag = { unreleased_since: ahead.out.split("\n")[0] || null };
  }
  const target = git(app, "rev-parse", `refs/remotes/${remote}/${branch}^{commit}`).out;
  const tag = newestTag(git(app, "tag", "--points-at", target).out.split("\n"));
  if (!tag) return save({ ...keep, status: "error", detail: `${remote}/${branch} (${target.slice(0, 7)}) carries no vX.Y.Z tag; not deploying` });
  const head = git(app, "rev-parse", "HEAD").out;
  if (head === target) return save({ ...keep, version: tag, sha: target, status: "current", detail: `running ${tag}` });
  // A tag that already failed and was rolled back isn't retried every pass: the hub stays on the
  // version before until a newer tag reaches the branch (fix forward).
  if (last?.status === "rolled-back" && last.previous === tag && last.sha === head) return save({ ...keep, status: "rolled-back", detail: `${tag} was rolled back; staying on ${last.version} until a newer release` });
  const dirty = git(app, "status", "--porcelain", "--untracked-files=no").out;
  if (dirty) return save({ ...keep, status: "blocked", detail: `${app} has uncommitted changes (${dirty.split("\n").length} file(s)); not deploying ${tag} over them` });

  const prev = label(app, head);
  fx.log(`${now()} deploying ${tag} (was ${prev})`);
  // deploy.restart tells the hub its next start was planned, not a restart by hand (src/measure.ts noteStart).
  const restart = () => { writeFileSync(join(dirname(file), "deploy.restart"), now() + "\n"); return fx.restart(); };
  const up = (ref: string) => git(app, "checkout", "-q", "--detach", ref).ok && fx.install(app) && restart();
  if (up(tag) && await fx.healthy()) return save({ status: "deployed", version: tag, sha: target, previous: prev, at: now(), detail: `deployed ${tag} (was ${prev}); hub healthy` });

  fx.log(`${now()} ${tag} failed to come up healthy; rolling back to ${prev}`);
  if (up(head) && await fx.healthy()) return save({ status: "rolled-back", version: prev, sha: head, previous: tag, at: now(), detail: `${tag} didn't come up healthy; back on ${prev}. Fix forward with a new release.` });
  return save({ status: "down", version: prev, sha: head, previous: tag, at: now(), detail: `${tag} didn't come up healthy and rolling back to ${prev} didn't either; the hub needs a look` });
}

// The real effects on the Mac.
const run = (cmd: string[], cwd?: string) => Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
export function macEffects(health: string): Effects {
  const uid = Bun.spawnSync(["id", "-u"], { stdout: "pipe" }).stdout.toString().trim();
  return {
    install: (dir) => run(["bun", "install", "--frozen-lockfile"], dir),
    // A plain kickstart of the hub; never the tunnel, never bootout.
    restart: () => run(["launchctl", "kickstart", "-k", `gui/${uid}/com.pocketbrain.start`]),
    healthy: async () => {
      await Bun.sleep(3000);
      for (let i = 0; i < 30; i++) {
        try { const r = await fetch(health, { signal: AbortSignal.timeout(3000) }); if (r.ok && (await r.json() as { ok?: boolean }).ok) return true; } catch { /* not up yet */ }
        await Bun.sleep(3000);
      }
      return false;
    },
    log: (l) => console.log(l),
  };
}

export function updatePlist(o: { bun: string; app: string; home: string; minutes: number }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const log = esc(join(o.home, "Library", "Logs", "com.pocketbrain.update.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pocketbrain.update</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(o.bun)}</string>
    <string>${esc(join(o.app, "scripts", "deploy.ts"))}</string>
    <string>run</string>
    <string>--app</string>
    <string>${esc(o.app)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(o.app)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${o.minutes * 60}</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

// One pass at a time: a lock file, taken over when older than 30 minutes.
function lock(): (() => void) | undefined {
  const p = join(configDir(), "deploy.lock");
  mkdirSync(configDir(), { recursive: true });
  try { if (Date.now() - statSync(p).mtimeMs > 30 * 60_000) rmSync(p); } catch { /* no lock */ }
  try { closeSync(openSync(p, "wx")); return () => rmSync(p, { force: true }); } catch { return undefined; }
}

async function main(argv: string[]): Promise<number> {
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const app = resolve(opt("--app") ?? join(homedir(), "pocketbrain"));
  const cmd = argv[0];
  if (cmd === "status") { const s = readState(); console.log(s ? JSON.stringify(s, null, 2) : "auto-update never ran"); return 0; }
  if (cmd === "hold") { mkdirSync(configDir(), { recursive: true }); writeFileSync(holdPath(), new Date().toISOString() + "\n"); console.log("on hold: the hub stays on its version"); return 0; }
  if (cmd === "unhold") { rmSync(holdPath(), { force: true }); console.log("following releases again"); return 0; }
  if (cmd === "plist") { console.log(updatePlist({ bun: Bun.which("bun") ?? "/opt/homebrew/bin/bun", app, home: homedir(), minutes: Number(opt("--minutes") ?? 10) })); return 0; }
  if (cmd === "run") {
    const unlock = lock();
    if (!unlock) { console.log("another pass is running"); return 0; }
    try {
      const s = await deployOnce({ app, fx: macEffects(opt("--health") ?? "http://127.0.0.1:8787/health") });
      return ["deployed", "current", "held"].includes(s.status) ? 0 : 1;
    } finally { unlock(); }
  }
  console.error("usage: bun scripts/deploy.ts run|status|hold|unhold|plist [--app <dir>] [--health <url>] [--minutes <n>]");
  return 2;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
