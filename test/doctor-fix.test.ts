// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain doctor --fix (backlog 266): each finding with a safe, known repair carries it;
// `--fix` previews every repair and changes nothing; `--fix --yes` runs them, logs one hand fix,
// and runs doctor again. A repair that fails says so and the others still run.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { applyFixes, type Fix } from "../src/doctor-fix";
import type { Finding } from "../src/doctor";

afterEach(() => { delete process.env.PB_REPLICA; });
const APP = join(import.meta.dir, "..");
const cli = (root: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", "src/cli.ts", ...a], { cwd: APP, env: { ...process.env, PB_BRAIN: root }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();
const fixes = (root: string) => existsSync(join(root, "log", "fixes.jsonl")) ? readFileSync(join(root, "log", "fixes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const findings = (root: string) => JSON.parse(cli(root, "doctor", "--offline", "--json").out) as Finding[];

const TUNNEL = `# my tunnel
tunnel: home-door
credentials-file: /keys/home-door.json
ingress:
  - hostname: brain.example.org
    service: http://127.0.0.1:8787
  - hostname: dash.example.org
    service: http://127.0.0.1:8788
`;

// A hub whose tunnel forwards every path and the dashboard, with no public_url, no
// rules/gardener.yaml, and a git lock left by a killed commit.
function brokenHub() {
  const root = makeBrain();
  const tf = join(mkdtempSync(join(tmpdir(), "pb-fix-")), "config.yml");
  writeFileSync(tf, TUNNEL);
  writeFileSync(join(root, "rules", "hub.yaml"), `hub: laptop\nepoch: 1\nreplicas:\n  laptop: {}\ntunnel:\n  name: home-door\n  config: ${tf}\n`);
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "hub");
  const lock = join(root, ".git", "index.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  process.env.PB_REPLICA = "laptop";
  return { root, tf, lock };
}

test("doctor marks each finding it can repair; --fix previews every repair and changes nothing", () => {
  const { root, tf, lock } = brokenHub();
  const f = findings(root);
  const fixOf = (re: RegExp) => f.find((x) => re.test(x.text))?.fix;
  expect(fixOf(/index\.lock/)).toBe("lock");
  expect(fixOf(/routes to the dashboard port/)).toBe("tunnel");
  expect(fixOf(/end its ingress/)).toBe("tunnel");
  expect(fixOf(/no public door/i)).toBe("public-url");
  expect(fixOf(/no public_url in rules\/hub\.yaml/i)).toBe("public-url");
  expect(fixOf(/gardener.s Anthropic side/i)).toBe("gardener-config");
  expect(fixOf(/has no snapshot/)).toBeUndefined(); // building one doesn't paste it: not a repair
  const head = git(root, "rev-parse", "HEAD");
  const r = cli(root, "doctor", "--offline", "--fix");
  expect(r.code).toBe(0);
  expect(r.out).toContain("remove .git/index.lock");
  expect(r.out).toContain(`rewrite the ingress in ${tf}`);
  expect(r.out).toContain("pocketbrain hub url https://brain.example.org");
  expect(r.out).toContain("ant_profile: pocketbrain");
  expect(r.out).toContain("pocketbrain doctor --fix --yes");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(tf, "utf8")).toBe(TUNNEL);
  expect(fixes(root)).toEqual([]);
});

test("--fix --yes runs each repair, keeps the tunnel's own lines, logs one hand fix, and doctor comes back without them", () => {
  const { root, tf, lock } = brokenHub();
  const r = cli(root, "doctor", "--offline", "--fix", "--yes");
  expect(r.err).toBe("");
  expect(existsSync(lock)).toBe(false);
  // The tunnel: same name, credentials and comment; only the agent API, then 404. The old file is kept.
  const text = readFileSync(tf, "utf8"), t = YAML.parse(text);
  expect(text).toContain("# my tunnel");
  expect(t).toMatchObject({ tunnel: "home-door", "credentials-file": "/keys/home-door.json" });
  expect(t.ingress).toHaveLength(2);
  expect(t.ingress[0]).toMatchObject({ hostname: "brain.example.org", service: "http://127.0.0.1:8787" });
  expect(t.ingress[0].path).toContain("mcp");
  expect(t.ingress[1]).toEqual({ service: "http_status:404" });
  expect(readFileSync(`${tf}.bak`, "utf8")).toBe(TUNNEL);
  expect(r.out).toContain("launchctl kickstart -k gui/$(id -u)/com.pocketbrain.tunnel");
  // The rules values, each its own owner commit.
  expect(YAML.parse(readFileSync(join(root, "rules", "hub.yaml"), "utf8")).public_url).toBe("https://brain.example.org");
  expect(YAML.parse(readFileSync(join(root, "rules", "gardener.yaml"), "utf8")).ant_profile).toBe("pocketbrain");
  expect(git(root, "log", "-2", "--format=%s")).toMatch(/owner: public_url https:\/\/brain\.example\.org[\s\S]*owner: ant_profile pocketbrain|owner: ant_profile pocketbrain[\s\S]*owner: public_url/);
  expect(git(root, "status", "--porcelain", "rules")).toBe("");
  // One hand fix for the real-use bar, naming what ran.
  expect(fixes(root)).toMatchObject([{ via: "auto:doctor-fix" }]);
  expect(fixes(root)[0].what).toMatch(/^ran pocketbrain doctor --fix: lock, gardener-config, public-url, tunnel$/);
  // Doctor ran again after the repairs and has nothing left to repair.
  expect(r.out).toContain("after the repairs:");
  expect(findings(root).filter((f) => f.fix)).toEqual([]);
  const again = cli(root, "doctor", "--offline", "--fix", "--yes");
  expect(again.out).toContain("nothing doctor can repair");
  expect(fixes(root)).toHaveLength(1);
});

test("a repair that fails says so, the others still run, and only what ran is logged", () => {
  const root = makeBrain();
  const fake: Record<string, Fix> = {
    boom: { preview: () => "would blow up", run: () => { throw new Error("it blew up"); } },
    fine: { preview: () => "would work", run: () => "worked" },
  };
  const f: Finding[] = [
    { area: "a", level: "FAIL", text: "one", fix: "boom" },
    { area: "b", level: "warn", text: "two", fix: "fine" },
    { area: "b", level: "warn", text: "three", fix: "fine" }, // one repair for both
    { area: "c", level: "warn", text: "four", fix: "unknown" },
  ];
  const done = applyFixes(root, f, fake);
  expect(done).toEqual([{ id: "boom", ok: false, text: "it blew up" }, { id: "fine", ok: true, text: "worked" }]);
  expect(fixes(root)).toMatchObject([{ what: "ran pocketbrain doctor --fix: fine", via: "auto:doctor-fix" }]);
});

test("no backup yet, or a stale one: the repair makes one now", () => {
  if (!Bun.which("age-keygen")) throw new Error("install age for test/doctor-fix.test.ts");
  const root = makeBrain();
  const keys = mkdtempSync(join(tmpdir(), "pb-fix-keys-")), dest = mkdtempSync(join(tmpdir(), "pb-fix-dest-"));
  Bun.spawnSync(["age-keygen", "-o", join(keys, "k")]);
  const pub = Bun.spawnSync(["age-keygen", "-y", join(keys, "k")]).stdout.toString().trim();
  expect(cli(root, "backup", "--init", "--pub", pub).code).toBe(0);
  writeFileSync(join(root, "rules", "backup.yaml"), readFileSync(join(root, "rules", "backup.yaml"), "utf8").replace("dest: ~/pocketbrain-backups", `dest: ${dest}`));
  git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qam", "dest");
  expect(findings(root).find((x) => /no backup made yet/i.test(x.text))?.fix).toBe("backup");
  const r = cli(root, "doctor", "--offline", "--fix", "--yes");
  expect(r.out).toMatch(/backup brain-.*\.tar\.age/);
  expect(readdirSync(dest).filter((f) => f.endsWith(".tar.age"))).toHaveLength(1);
  expect(findings(root).find((x) => x.area === "backup")?.fix).toBeUndefined();
});
