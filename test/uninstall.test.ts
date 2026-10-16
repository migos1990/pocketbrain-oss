// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain uninstall` (docs/quickstart.md#leaving): a pilot user who leaves gets every place
// pocketBrain put something on their Mac removed in one command, sees each step before it runs, and
// keeps their brain and its backups unless they ask otherwise. What lives in their accounts (sign-in
// clients, the tunnel, the gardener's deployments) is listed with the exact command or page, never run.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { uninstallPlan, runUninstall, planText } from "../src/uninstall";
import type { Run } from "../src/menubar";
import { main } from "../src/cli";

const MARK = "# written by pocketbrain door install";

// A Mac as a pilot user leaves it: hub, tunnel and update jobs, logs, a tunnel config pocketBrain
// wrote, the menu-bar app, the keys folder, a brain with sign-in clients and a managed gardener, backups.
function mac() {
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const la = join(home, "Library", "LaunchAgents");
  mkdirSync(la, { recursive: true });
  for (const l of ["com.pocketbrain.start", "com.pocketbrain.tunnel", "com.pocketbrain.update"]) writeFileSync(join(la, `${l}.plist`), "<plist/>");
  writeFileSync(join(la, "com.other.app.plist"), "<plist/>");
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  writeFileSync(join(home, "Library", "Logs", "com.pocketbrain.start.log"), "owner dashboard (this machine only): http://127.0.0.1:8788/login?key=abc\n");
  writeFileSync(join(home, "Library", "Logs", "com.other.app.log"), "x");
  const cf = join(home, ".cloudflared");
  mkdirSync(cf, { recursive: true });
  const cred = join(cf, "0f0f0f0f-0000-4000-8000-000000000001.json");
  writeFileSync(cred, "{}");
  writeFileSync(join(cf, "config.yml"), `${MARK}\ntunnel: 0f0f0f0f-0000-4000-8000-000000000001\ncredentials-file: ${cred}\n`);
  writeFileSync(join(cf, "cert.pem"), "x");
  mkdirSync(join(home, "Applications", "PocketBrain.app", "Contents"), { recursive: true });
  const config = join(home, ".config", "pocketbrain");
  mkdirSync(join(config, "keys"), { recursive: true });
  writeFileSync(join(config, "keys", "AUTH0_MGMT_CLIENT_SECRET"), "s");
  const brain = makeBrain();
  writeFileSync(join(config, "brain"), brain + "\n");
  const backups = join(home, "pocketbrain-backups");
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, "brain-2026-10-15.tar.age"), "x");
  writeFileSync(join(brain, "rules", "backup.yaml"), YAML.stringify({ dest: backups, recipients: ["age1example"] }));
  writeFileSync(join(brain, "rules", "hub.yaml"), YAML.stringify({ hub: "mac", epoch: 1, replicas: {}, public_url: "https://sam.brains.example", tunnel: { kind: "cloudflare", name: "0f0f0f0f-0000-4000-8000-000000000001", config: join(cf, "config.yml") } }));
  writeFileSync(join(brain, "rules", "oauth.yaml"), YAML.stringify({ issuer: "https://sam.auth.example/", resource: "https://sam.brains.example/mcp/oauth", owner_subject: "auth0|1", clients: { "cl-desk": { agent: "claude", bound: "2026-10-01", name: "Claude desktop" } }, machines: { "cl-machine": { agent: "town", bound: "2026-10-02" } } }));
  const agents = join(home, "pocketbrain-agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "claude-lock.json"), JSON.stringify({ resources: { "gardener/vault.yaml": { id: "vlt_1" }, "gardener/deployment-nightly.yaml": { id: "dep_night" }, "gardener-weekly/deployment-weekly.yaml": { id: "dep_week" } } }));
  writeFileSync(join(brain, "rules", "gardener.yaml"), YAML.stringify({ ant_profile: "pb-sam", lock_file: join(agents, "claude-lock.json") }));
  return { home, config, brain, backups, cred, cf };
}
const fakeRun = () => { const calls: string[][] = []; const run: Run = (cmd) => { calls.push(cmd); return { code: 0, out: "" }; }; return { calls, run }; };

test("the plan names every place pocketBrain put something, and running nothing changes nothing", () => {
  const m = mac();
  const steps = uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501 });
  const text = planText(steps);
  for (const l of ["com.pocketbrain.start", "com.pocketbrain.tunnel", "com.pocketbrain.update"]) expect(text).toContain(`launchctl bootout gui/501/${l}`);
  expect(text).toContain(join(m.home, "Library", "Logs", "com.pocketbrain.start.log"));
  expect(text).toContain(join(m.cf, "config.yml"));
  expect(text).toContain(m.cred);
  expect(text).toContain(join(m.home, "Applications", "PocketBrain.app"));
  expect(text).toContain(m.config);
  expect(text).not.toContain("com.other.app");
  expect(text).not.toContain("cert.pem");
  // Built from the plan alone: every file is still there.
  expect(existsSync(join(m.home, "Library", "LaunchAgents", "com.pocketbrain.start.plist"))).toBe(true);
  expect(existsSync(m.config)).toBe(true);
});

test("--yes stops each job before removing its file, removes only pocketBrain's things, and keeps the brain and backups", () => {
  const m = mac();
  const { calls, run } = fakeRun();
  const lines = runUninstall(uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501 }), { run });
  expect(calls.map((c) => c.join(" "))).toEqual(["com.pocketbrain.start", "com.pocketbrain.tunnel", "com.pocketbrain.update"].sort().map((l) => `launchctl bootout gui/501/${l}`));
  for (const l of ["start", "tunnel", "update"]) expect(existsSync(join(m.home, "Library", "LaunchAgents", `com.pocketbrain.${l}.plist`))).toBe(false);
  expect(existsSync(join(m.home, "Library", "LaunchAgents", "com.other.app.plist"))).toBe(true);
  expect(existsSync(join(m.home, "Library", "Logs", "com.pocketbrain.start.log"))).toBe(false);
  expect(existsSync(join(m.home, "Library", "Logs", "com.other.app.log"))).toBe(true);
  expect(existsSync(join(m.cf, "config.yml"))).toBe(false);
  expect(existsSync(m.cred)).toBe(false);
  expect(existsSync(join(m.cf, "cert.pem"))).toBe(true);
  expect(existsSync(join(m.home, "Applications", "PocketBrain.app"))).toBe(false);
  expect(existsSync(m.config)).toBe(false);
  expect(existsSync(join(m.brain, "rules", "policy.yaml"))).toBe(true);
  expect(existsSync(join(m.backups, "brain-2026-10-15.tar.age"))).toBe(true);
  expect(lines.join("\n")).toContain(`kept your brain: ${m.brain}`);
  expect(lines.join("\n")).toContain(`kept your backups: ${m.backups}`);
});

test("what lives in the user's accounts is listed with the exact step, never run", () => {
  const m = mac();
  const { calls, run } = fakeRun();
  const steps = uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501 });
  const text = planText(steps);
  expect(text).toContain("cl-desk (claude, Claude desktop)");
  expect(text).toContain("cl-machine (town)");
  expect(text).toContain("cloudflared tunnel delete 0f0f0f0f-0000-4000-8000-000000000001");
  expect(text).toContain("sam.brains.example");
  for (const d of ["dep_night", "dep_week"]) expect(text).toContain(`env -u ANTHROPIC_API_KEY ant --profile pb-sam beta:deployments pause --deployment-id ${d}`);
  expect(text).toContain("vlt_1");
  runUninstall(steps, { run });
  expect(calls.every((c) => c[0] === "launchctl")).toBe(true);
});

test("a tunnel config pocketBrain didn't write is kept, and so is the credentials file it names", () => {
  const m = mac();
  writeFileSync(join(m.cf, "config.yml"), `tunnel: mine\ncredentials-file: ${m.cred}\n`);
  const { run } = fakeRun();
  const steps = uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501 });
  expect(planText(steps)).toContain("pocketBrain didn't write it");
  runUninstall(steps, { run });
  expect(existsSync(join(m.cf, "config.yml"))).toBe(true);
  expect(existsSync(m.cred)).toBe(true);
});

test("a credentials file named outside ~/.cloudflared is never removed", () => {
  const m = mac();
  const elsewhere = join(m.home, "Documents", "precious.json");
  mkdirSync(join(m.home, "Documents"), { recursive: true });
  writeFileSync(elsewhere, "{}");
  writeFileSync(join(m.cf, "config.yml"), `${MARK}\ncredentials-file: ${elsewhere}\n`);
  runUninstall(uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501 }), fakeRun());
  expect(existsSync(elsewhere)).toBe(true);
});

test("--remove-brain removes the brain folder, never the backups; it refuses a folder that isn't a brain", () => {
  const m = mac();
  runUninstall(uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501, removeBrain: true }), fakeRun());
  expect(existsSync(m.brain)).toBe(false);
  expect(existsSync(join(m.backups, "brain-2026-10-15.tar.age"))).toBe(true);
  const n = mac();
  expect(() => uninstallPlan({ home: n.home, config: n.config, brain: n.home, uid: 501, removeBrain: true })).toThrow(/isn't a brain/);
  writeFileSync(join(n.home, "x"), "");
  mkdirSync(join(n.home, "rules"), { recursive: true });
  writeFileSync(join(n.home, "rules", "policy.yaml"), "agents: {}\n");
  expect(() => uninstallPlan({ home: n.home, config: n.config, brain: n.home, uid: 501, removeBrain: true })).toThrow(/home folder/);
});

test("a job that wasn't running doesn't stop the rest", () => {
  const m = mac();
  const run: Run = (cmd) => ({ code: cmd.at(-1)!.endsWith("tunnel") ? 3 : 0, out: "Boot-out failed: 3: No such process" });
  const lines = runUninstall(uninstallPlan({ home: m.home, config: m.config, brain: m.brain, uid: 501 }), { run });
  expect(lines.join("\n")).toContain("com.pocketbrain.tunnel wasn't running");
  expect(existsSync(join(m.home, "Library", "LaunchAgents", "com.pocketbrain.tunnel.plist"))).toBe(false);
  expect(existsSync(m.config)).toBe(false);
});

test("on a Mac with nothing installed the plan says so and still keeps the brain", () => {
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  const steps = uninstallPlan({ home, config: join(home, ".config", "pocketbrain"), uid: 501 });
  expect(planText(steps)).toContain("nothing of pocketBrain's is installed here");
});

test("the command prints the plan and changes nothing without --yes; --remove-brain needs --yes too", () => {
  const m = mac();
  const env = { HOME: process.env.HOME, PB_CONFIG_DIR: process.env.PB_CONFIG_DIR };
  process.env.HOME = m.home; process.env.PB_CONFIG_DIR = m.config;
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try {
    expect(main(["uninstall", "--brain", m.brain])).toBe(0);
    expect(main(["uninstall", "--brain", m.brain, "--remove-brain"])).toBe(0);
  } finally { console.log = log; process.env.HOME = env.HOME; if (env.PB_CONFIG_DIR === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = env.PB_CONFIG_DIR; }
  const text = out.join("\n");
  expect(text).toContain("pocketbrain uninstall would:");
  expect(text).toContain("Nothing removed yet. If this is right, run the same command with --yes.");
  expect(text).toContain(`remove the brain: ${m.brain}`);
  expect(existsSync(join(m.home, "Library", "LaunchAgents", "com.pocketbrain.start.plist"))).toBe(true);
  expect(existsSync(m.config)).toBe(true);
  expect(existsSync(m.brain)).toBe(true);
});

test("the settings folder is kept when it holds the brain, the backups or the home folder", () => {
  const m = mac();
  const steps = uninstallPlan({ home: m.home, config: m.home, brain: m.brain, uid: 501 });
  expect(steps.some((s) => s.kind === "remove" && s.path === m.home)).toBe(false);
  expect(planText(steps)).toContain(`keep your settings folder (it holds your home folder, brain or backups): ${m.home}`);
  const n = mac();
  const steps2 = uninstallPlan({ home: n.home, config: dirname(n.brain), brain: n.brain, uid: 501 });
  expect(steps2.some((s) => s.kind === "remove" && s.path === dirname(n.brain))).toBe(false);
});
