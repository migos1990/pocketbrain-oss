// SPDX-License-Identifier: AGPL-3.0-only
// No hand-typed rules files (backlog #248): every rules/ value the product tells the owner to set
// has a command that edits only its own keys and commits as the owner (src/ownerset.ts), and
// `pocketbrain doctor` names the command when the value is missing.
import { test, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { nightMode, gardenerConfig } from "../src/gardener";
import { doctor } from "../src/doctor";

afterEach(() => { delete process.env.PB_REPLICA; });
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (root: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...a], { env: { ...process.env, PB_BRAIN: root } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();
const rules = (root: string, f: string) => readFileSync(join(root, "rules", f), "utf8");
const hubYaml = (root: string, extra = "") => writeFileSync(join(root, "rules", "hub.yaml"), `# the owner's machines\nhub: laptop\nepoch: 1\nreplicas:\n  laptop: {}\n  home: {}\n${extra}`);

test("gardener setup writes only its own keys of rules/gardener.yaml, keeps the rest and its comments, and commits as the owner", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "gardener.yaml"), "# mine\nrotate_days: 3\nant_profile: old\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "gardener.yaml by hand");
  const r = cli(root, "gardener", "setup", "--profile", "pocketbrain", "--lock", "~/pocketbrain-agents/claude-lock.json");
  expect(r.code).toBe(0);
  const text = rules(root, "gardener.yaml");
  expect(text).toContain("# mine");
  expect(gardenerConfig(root)).toMatchObject({ ant_profile: "pocketbrain", lock_file: "~/pocketbrain-agents/claude-lock.json", rotate_days: 3 });
  expect(git(root, "log", "-1", "--format=%an %s")).toMatch(/^Robin owner: /) // the owner, by owner.name;
  expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("rules/gardener.yaml");
  // Same values again: nothing to commit.
  const before = git(root, "rev-parse", "HEAD");
  expect(cli(root, "gardener", "setup", "--profile", "pocketbrain").out).toContain("already");
  expect(git(root, "rev-parse", "HEAD")).toBe(before);
});

test("gardener setup refuses a value that isn't one: a profile with spaces, a new file with no lock, an http door", () => {
  const root = makeBrain();
  expect(cli(root, "gardener", "setup", "--profile", "my profile", "--lock", "/x/claude-lock.json").code).toBe(2);
  expect(cli(root, "gardener", "setup", "--profile", "pocketbrain").code).toBe(2); // no gardener.yaml yet and no --lock
  expect(cli(root, "gardener", "setup", "--lock", "/x/claude-lock.json", "--mcp-url", "http://brain.example/mcp").code).toBe(2);
  expect(existsSync(join(root, "rules", "gardener.yaml"))).toBe(false);
});

test("gardener setup --vault puts the vault id in both deployment files beside the lock file", () => {
  const root = makeBrain(), dir = join(root, "..", `agents-${Date.now()}`);
  for (const rel of ["agents/gardener/deployment-nightly.yaml", "agents/gardener-weekly/deployment-weekly.yaml"]) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "vault_ids:\n  - YOUR_VAULT_ID\n");
  }
  expect(cli(root, "gardener", "setup", "--lock", join(dir, "claude-lock.json"), "--vault", "vlt_01ABCdef").code).toBe(0);
  expect(readFileSync(join(dir, "agents/gardener/deployment-nightly.yaml"), "utf8")).toContain("vlt_01ABCdef");
  expect(readFileSync(join(dir, "agents/gardener-weekly/deployment-weekly.yaml"), "utf8")).not.toContain("YOUR_VAULT_ID");
  expect(cli(root, "gardener", "setup", "--vault", "bad id;rm").code).toBe(2);
});

test("night managed|local: policy.yaml on a single machine, rules/hub.yaml once there is one", () => {
  const root = makeBrain();
  expect(cli(root, "night", "managed").code).toBe(0);
  expect(nightMode(root)).toBe("managed");
  expect(YAML.parse(rules(root, "policy.yaml")).night).toBe("managed");
  expect(cli(root, "night", "sometimes").code).toBe(2);
  hubYaml(root);
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "hub");
  process.env.PB_REPLICA = "laptop";
  expect(cli(root, "night", "local").code).toBe(0);
  expect(YAML.parse(rules(root, "hub.yaml")).night).toBe("local");
  expect(rules(root, "hub.yaml")).toContain("# the owner's machines");
  expect(nightMode(root)).toBe("local");
});

test("hub url sets public_url on the hub only, https only; a replica is told to do it on the hub", () => {
  const root = makeBrain();
  hubYaml(root);
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "hub");
  process.env.PB_REPLICA = "laptop";
  expect(cli(root, "hub", "url", "http://brain.example").code).toBe(2);
  expect(cli(root, "hub", "url", "https://brain.example/").code).toBe(0);
  expect(YAML.parse(rules(root, "hub.yaml")).public_url).toBe("https://brain.example");
  process.env.PB_REPLICA = "home";
  const r = cli(root, "hub", "url", "https://other.example");
  expect(r.code).toBe(1);
  expect(r.err).toContain("on the hub (laptop)");
  expect(YAML.parse(rules(root, "hub.yaml")).public_url).toBe("https://brain.example");
});

test("doctor names the command for each value the owner still has to set", async () => {
  const root = makeBrain();
  hubYaml(root);
  writeFileSync(join(root, "rules", "fga.yaml"), "api_url: https://fga.example\nstore_id: s1\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "hub");
  process.env.PB_REPLICA = "laptop";
  const text = (await doctor(root, { offline: true })).filter((f) => f.area === "setup").map((f) => f.text).join("\n");
  expect(text).toContain("pocketbrain hub url https://");
  expect(text).toContain("pocketbrain gardener setup --profile");
  expect(text).toContain("pocketbrain fga model");
});

test("tend's manual steps name the commands, not a YAML edit", async () => {
  const { tendPlan, manualSteps } = await import("../src/tend");
  const steps = manualSteps(tendPlan(makeBrain(), { url: "https://brain.example", dir: "/tmp/pb-agents" }));
  expect(steps).toContain("pocketbrain gardener setup --profile pocketbrain --lock /tmp/pb-agents/claude-lock.json");
  expect(steps).toContain("pocketbrain gardener setup --vault");
  expect(steps).toContain("pocketbrain night managed");
  expect(steps).not.toMatch(/write rules\/|in rules\/hub\.yaml/);
});

test("aftercheck classify on --cap 1 turns the second opinion on with its own step cap, keeps the rest of policy.yaml, and off turns it off", () => {
  const root = makeBrain();
  const p = join(root, "rules", "policy.yaml");
  const before = YAML.parse(readFileSync(p, "utf8"));
  writeFileSync(p, YAML.stringify({ ...before, aftercheck: { conflicts: true }, usage: { cap: { monthly: 20, steps: { "capture.extract": 5 } } } }));
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "policy by hand");
  const on = cli(root, "aftercheck", "classify", "on", "--cap", "1");
  expect(on.code).toBe(0);
  const after = YAML.parse(rules(root, "policy.yaml"));
  expect(after.aftercheck).toEqual({ conflicts: true, classify: true });
  expect(after.usage.cap).toEqual({ monthly: 20, steps: { "capture.extract": 5, "write.classify": 1 } });
  expect(after.agents).toEqual(before.agents);
  expect(git(root, "log", "-1", "--format=%s")).toMatch(/^owner: aftercheck classify on/);
  expect(git(root, "status", "--porcelain")).toBe("");
  const off = cli(root, "aftercheck", "classify", "off");
  expect(off.code).toBe(0);
  const last = YAML.parse(rules(root, "policy.yaml"));
  expect(last.aftercheck.classify).toBe(false);
  expect(last.usage.cap.steps["write.classify"]).toBe(1);
  expect(cli(root, "aftercheck", "classify", "on", "--cap", "lots").code).not.toBe(0);
});
