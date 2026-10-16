// SPDX-License-Identifier: AGPL-3.0-only
// The canary kit: `probe init` plants decoy notes, each carrying a unique canary, in the probe
// area that only a slice naming it can reach; the leak oracle finds canaries in any text; the
// write path and the relay refuse and alert on a canary from an agent that can't see it.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { probeInit, loadCanaries, findCanaries } from "../src/canary";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { contextPack, search, readNote, remember } from "../src/core";
import { write } from "../src/write";
import { checkMessage, loadRelayConfig } from "../src/relay";
import { useCells, cellsOn } from "../src/cell";

const REPO = join(import.meta.dir, "..");
const alerts = (root: string) => { const f = join(root, "log", "alerts.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const gitOut = (root: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root }).stdout.toString().trim();
const withProber = (root: string) => {
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("tiers:", "  auditor: { tier: trial, slices: [probe] }\ntiers:"));
  Bun.spawnSync(["git", "commit", "-qam", "owner: prober"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
};

test("probe init: decoys in the probe area, one owner commit, canaries recorded in rules/ and printed", () => {
  const root = makeBrain();
  const before = Number(gitOut(root, ["rev-list", "--count", "HEAD"]));
  const r = probeInit(root);
  expect(r.changed).toBe(true);
  expect(r.planted.map((p) => p.sensitivity)).toEqual(["personal", "private", "secret"]);
  expect(new Set(r.planted.map((p) => p.canary)).size).toBe(3);
  for (const p of r.planted) {
    const n = loadBrain(root).find((x) => x.fm.id === p.id)!;
    expect(n.fm.area).toBe("probe");
    expect(n.fm.tags).toContain("canary");
    expect(n.fm.sensitivity).toBe(p.sensitivity);
    expect(JSON.stringify(n.fm.facts) + n.body).toContain(p.canary);
  }
  expect(Number(gitOut(root, ["rev-list", "--count", "HEAD"]))).toBe(before + 1);
  expect(gitOut(root, ["log", "-1", "--format=%an"])).toBe("Robin");
  expect(gitOut(root, ["status", "--porcelain"]).split("\n").filter((l) => l && !l.includes("log/"))).toEqual([]);
  const file = YAML.parse(readFileSync(join(root, "rules", "canaries.yaml"), "utf8"));
  expect(file.canaries).toEqual(r.planted.map((p) => p.canary));
  expect(loadRules(root).slices.probe).toEqual({ areas: ["probe"] });
  expect(r.text).toContain(r.planted[0].canary);
});

test("probe init is idempotent; --rotate makes new canaries and keeps the old ones watched", () => {
  const root = makeBrain();
  const a = probeInit(root);
  const head = gitOut(root, ["rev-parse", "HEAD"]);
  const b = probeInit(root);
  expect(b.changed).toBe(false);
  expect(b.planted).toEqual(a.planted);
  expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(head);
  const c = probeInit(root, { rotate: true });
  expect(c.changed).toBe(true);
  expect(c.planted.map((p) => p.canary).some((x) => a.planted.some((p) => p.canary === x))).toBe(false);
  expect(loadCanaries(root).retired).toEqual(a.planted.map((p) => p.canary));
  expect(findCanaries(root, `old one: ${a.planted[1].canary}`).map((h) => h.canary)).toEqual([a.planted[1].canary]);
});

test("only a slice that names the probe area reaches the decoys; the all slice and type slices never do", () => {
  const root = makeBrain();
  const r = probeInit(root);
  withProber(root);
  const rules = loadRules(root), notes = loadBrain(root);
  const sees = (agent: string) => r.planted.filter((p) => carve(notes, rules, grantFor(rules, agent)).visible.has(p.id)).map((p) => p.sensitivity);
  for (const a of ["steward", "planner", "gardener", "helper"]) expect(sees(a), a).toEqual([]);
  expect(sees("auditor")).toEqual(["personal"]);
});

test("context, search and read never hand a canary to an agent without the probe slice", () => {
  const root = makeBrain();
  const r = probeInit(root);
  for (const agent of ["steward", "planner", "helper", "gardener"]) {
    const out = [contextPack(root, agent), contextPack(root, agent, "probe decoy reference"), JSON.stringify(search(root, agent, r.planted[0].canary)), JSON.stringify(search(root, agent, "probe decoy reference"))].join("\n");
    expect(findCanaries(root, out), agent).toEqual([]);
    for (const p of r.planted) expect(() => readNote(root, agent, p.id), `${agent} ${p.id}`).toThrow(`no note ${p.id} in your view`);
  }
});

test("the leak oracle: any canary in a text; with an agent, only canaries it can't see", () => {
  const root = makeBrain();
  const r = probeInit(root);
  withProber(root);
  const [pers, priv] = r.planted;
  const text = `the answer was ${pers.canary.toUpperCase()} and also ${priv.canary.replace(/ /g, "-")}`;
  expect(findCanaries(root, text).map((h) => h.id)).toEqual([pers.id, priv.id]);
  expect(findCanaries(root, text, "auditor").map((h) => h.id)).toEqual([priv.id]);
  expect(findCanaries(root, text, "helper").map((h) => h.id)).toEqual([pers.id, priv.id]);
  expect(findCanaries(root, "nothing here")).toEqual([]);
});

test("a canary in a write from an agent that can't see it is refused and alerts; nothing commits", () => {
  const root = makeBrain();
  const r = probeInit(root);
  const head = gitOut(root, ["rev-parse", "HEAD"]);
  const base = { as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };
  // The personal decoy isn't private, so the ordinary leak tripwire doesn't cover it.
  const w1 = write(root, { ...base, agent: "planner", id: "projects/course-a", attribute: "next_step", value: `check ${r.planted[0].canary}` });
  expect(w1.outcome).toBe("refused");
  expect(w1.fails?.[0].check).toBe("leak_tripwire");
  const w2 = remember(root, "steward", { ...base, id: "projects/course-a", attribute: "next_step", value: "x", sources: [`doc:${r.planted[0].canary.replace(/ /g, "-")}`] });
  expect(w2.outcome).toBe("refused");
  expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(alerts(root).filter((a) => a.check === "canary").map((a) => [a.agent, a.from])).toEqual([["planner", r.planted[0].id], ["steward", r.planted[0].id]]);
});

test("the relay holds and alerts on mail carrying a planted canary, from rules/canaries.yaml", () => {
  const root = makeBrain();
  const r = probeInit(root);
  const cfg = loadRelayConfig(root);
  expect(cfg.canaries).toContain(r.planted[2].canary);
  expect(cfg.canaries).toContain("Zephyr Holdings 7731"); // relay.yaml's own list still counts
  const v = checkMessage(loadBrain(root), loadRules(root), cfg, { id: "m1", from: "planner@brain.example", to: ["relay+helper@brain.example"], subject: "fyi", text: `ref ${r.planted[2].canary}` });
  expect(v.deliver).toBe(false);
  expect(v.alert).toBe(true);
});

test("CLI: probe init prints the canaries; probe check reads a file or stdin and exits 1 on a find", () => {
  const root = makeBrain();
  const run = (args: string[], stdin?: string) => Bun.spawnSync(["bun", join(REPO, "src", "cli.ts"), ...args, "--brain", root], { cwd: REPO, env: { ...process.env }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin) });
  const init = run(["probe", "init"]);
  expect(init.exitCode).toBe(0);
  const list = loadCanaries(root).canaries;
  for (const c of list) expect(init.stdout.toString()).toContain(c);
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(join(root, "tmp", "answer.txt"), `fine, nothing to see`);
  expect(run(["probe", "check", join(root, "tmp", "answer.txt")]).exitCode).toBe(0);
  const hit = run(["probe", "check", "-"], `it said ${list[1]}`);
  expect(hit.exitCode).toBe(1);
  expect(hit.stdout.toString()).toContain(list[1]);
});

test("a read that would hand out a canary the agent's carve doesn't hold alerts (canary_served)", () => {
  const root = makeBrain();
  const r = probeInit(root);
  // Someone copied a decoy's canary into a note helper does see.
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8") + `\nRef ${r.planted[0].canary}\n`);
  contextPack(root, "helper");
  readNote(root, "helper", "projects/course-a");
  expect(alerts(root).filter((a) => a.check === "canary_served").map((a) => [a.agent, a.from])).toEqual([["helper", r.planted[0].id], ["helper", r.planted[0].id]]);
});

test("a prober reads its personal decoy through its cell too (serve answers from cells)", () => {
  const root = makeBrain();
  const r = probeInit(root);
  withProber(root);
  const personal = r.planted.find((p) => p.sensitivity === "personal")!;
  const was = cellsOn();
  try {
    for (const on of [false, true]) {
      useCells(on);
      expect(JSON.stringify(readNote(root, "auditor", personal.id)), `cells ${on}`).toContain(personal.canary);
      expect(findCanaries(root, contextPack(root, "auditor")).map((h) => h.id), `cells ${on}`).toEqual([personal.id]);
      for (const p of r.planted.filter((x) => x !== personal)) expect(() => readNote(root, "auditor", p.id), `cells ${on}`).toThrow(`no note ${p.id} in your view`);
    }
  } finally { useCells(was); }
});
