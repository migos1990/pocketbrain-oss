// SPDX-License-Identifier: AGPL-3.0-only
// A trusted (core) assistant's guess at a hidden value answers once, then never again (audit v12,
// G680; the owner's choice 2026-11-06: "one guess, then proposals only"). G648 made a trial
// assistant's hit and miss both go to the inbox; a core assistant's write commits, so a hit was
// refused with leak_tripwire while a miss committed, and the difference confirmed each guess. Now
// the first hit is still refused (the owner is alerted), and from then on that assistant's writes
// all go to the owner's inbox like a trial assistant's, a hit and a miss alike, until the owner
// lets it write again from Settings.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { remember } from "../src/core";
import { readJsonl } from "../src/util";
import { git } from "../src/git";
import { loadBrain } from "../src/brain";

// A money page planner can't see (its grant leaves out money); the audit's pair of titles.
function withHydro() {
  const root = makeBrain();
  writeFileSync(join(root, "money/hydro.md"), `---
id: money/hydro
type: money
title: Utilities
area: personal
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  payee: { value: Hydro bill for the cottage, as_of: 2026-10-01, sources: ["gmail:f000000000000004"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
---
`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "hydro"]);
  return root;
}
const page = (title: string) => ({ title, type: "org", area: "work", attribute: "what_it_is", value: "a company", as_of: "2026-10-05", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
const alerts = (root: string) => existsSync(join(root, "log/alerts.jsonl")) ? readJsonl<{ check?: string }>(join(root, "log/alerts.jsonl")).filter((a) => a.check === "leak_tripwire").length : 0;
const shape = (r: { outcome: string; message?: string; file?: string; fails?: unknown }) => JSON.stringify({ ...r, file: r.file ? "F" : undefined, message: (r.message ?? "").replace(/inbox\/\S+/g, "F") });
const titled = (root: string, t: string) => loadBrain(root).some((n) => n.fm.title === t);

test("a core assistant's first guess is refused, and after it a hit and a miss answer the same", () => {
  const root = withHydro();
  const before = alerts(root);
  const first = remember(root, "planner", page("Hydro bill October"));
  expect(first.outcome).toBe("refused");
  expect(first.fails?.[0]?.check).toBe("leak_tripwire");
  expect(alerts(root)).toBe(before + 1);
  // From now on: proposals only, whatever it writes.
  const hit = remember(root, "planner", page("Hydro bill November"));
  const miss = remember(root, "planner", page("Phone bill October"));
  expect(miss.outcome).toBe("inbox");
  expect(shape(hit)).toBe(shape(miss));
  expect(titled(root, "Phone bill October")).toBe(false);
  expect(titled(root, "Hydro bill November")).toBe(false);
  // The owner still hears of each guess; only the guess's proposal carries the owner-only mark.
  expect(alerts(root)).toBe(before + 2);
  const doc = (f: string) => YAML.parse(readFileSync(join(root, f), "utf8")) as { leak?: boolean };
  expect(doc(hit.file!).leak).toBe(true);
  expect(doc(miss.file!).leak).toBeUndefined();
});

test("a journal line from an assistant on proposals only is refused whatever it says", () => {
  const root = withHydro();
  remember(root, "planner", page("Hydro bill October"));
  const j = (text: string) => remember(root, "planner", { kind: "journal", text, sources: ["agent:planner"], as_of: "2026-10-05" } as never);
  expect(shape(j("Paid the Hydro bill for the cottage"))).toBe(shape(j("Paid the phone bill")));
});

test("before any guess, and for other assistants, nothing changes", () => {
  const root = withHydro();
  expect(remember(root, "planner", page("Phone bill October")).outcome).toBe("committed");
  remember(root, "steward", page("Some page"));
  expect(remember(root, "planner", page("Water bill October")).outcome).toBe("committed");
});

test("the owner lets it write again from Settings, and its writes commit as before", async () => {
  const { runAction } = await import("../src/dashboard/actions");
  const { overview } = await import("../src/dashboard/html");
  const { loadState } = await import("../src/dashboard/data");
  const root = withHydro();
  remember(root, "planner", page("Hydro bill October"));
  const settings = overview(loadState(root), "csrf").body;
  expect(settings).toContain("writes go to you");
  expect(settings).toContain("write-unhold");
  expect(runAction({ root }, "write-unhold", { agent: "planner" })).toMatch(/writes again/);
  expect(overview(loadState(root), "csrf").body).not.toContain("write-unhold");
  expect(remember(root, "planner", page("Phone bill October")).outcome).toBe("committed");
});

test("the CLI says who is on proposals only and lets one write again", () => {
  const root = withHydro();
  remember(root, "planner", page("Hydro bill October"));
  const cli = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...a], { env: { ...process.env, PB_BRAIN: root } });
  expect(cli("write-hold").stdout.toString()).toContain("planner");
  expect(cli("write-hold", "clear", "planner").exitCode).toBe(0);
  expect(cli("write-hold").stdout.toString()).toContain("No assistant");
  expect(remember(root, "planner", page("Phone bill October")).outcome).toBe("committed");
});

// Slice audit of G680: the hub's own filing must not file a held writer's proposals, or the hit
// and the miss differ again one tick later (the miss files, the hit is refused).
test("the hub's filing leaves a held assistant's proposals to the owner, a hit and a miss alike", async () => {
  const { runAuto } = await import("../src/filing");
  const { search } = await import("../src/core");
  const root = withHydro();
  remember(root, "planner", page("Hydro bill October"));
  remember(root, "planner", page("Hydro bill November"));
  remember(root, "planner", page("Phone bill October"));
  runAuto(root, new Date("2026-10-30T15:00:00Z"));
  expect(titled(root, "Phone bill October")).toBe(false);
  expect(titled(root, "Hydro bill November")).toBe(false);
  expect(JSON.stringify(search(root, "planner", "Phone bill"))).not.toContain("phone-bill-october");
});

// A canary hit and a real hit answer the same and both spend the one guess (src/canary.ts: the
// agent sees an ordinary leak refusal).
test("a canary in a core assistant's write answers like a real hit and holds it too", async () => {
  const { probeInit } = await import("../src/canary");
  const { writesHeld } = await import("../src/write-hold");
  const a = withHydro(), b = withHydro();
  const canary = probeInit(a).planted[0].canary;
  probeInit(b);
  const viaCanary = remember(a, "planner", page(`Note ${canary}`));
  const viaHidden = remember(b, "planner", page("Hydro bill October"));
  expect(viaCanary.message).toBe(viaHidden.message);
  expect([writesHeld(a, "planner"), writesHeld(b, "planner")]).toEqual([true, true]);
});

test("the owner accepting a held assistant's guess is told of the leak, not of a new hold", async () => {
  const { decideProposal } = await import("../src/write");
  const root = withHydro();
  remember(root, "planner", page("Hydro bill October"));
  const hit = remember(root, "planner", page("Hydro bill November"));
  const r = decideProposal(root, hit.file!, "accept");
  expect(JSON.stringify(r)).not.toContain("From now on");
});

// Re-audit of G680: the filing's other "files itself" branches (a core Gardener's proposals, the
// capture agent's fact about the owner) must leave a held writer's proposals to the owner too.
test("a held Gardener made core: the hub's filing files neither its hit nor its miss", async () => {
  const { runAuto } = await import("../src/filing");
  const root = withHydro();
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("  planner: { tier: core,", "  garden: { role: gardener, tier: core, slices: [area:work, contacts-basic], exclude_types: [money] }\n  planner: { tier: core,"));
  git(root, ["commit", "-qam", "a core gardener"]);
  expect(remember(root, "garden", page("Hydro bill October")).outcome).toBe("refused");
  remember(root, "garden", page("Hydro bill November"));
  remember(root, "garden", page("Phone bill October"));
  runAuto(root, new Date("2026-10-30T15:00:00Z"));
  expect(titled(root, "Phone bill October")).toBe(false);
  expect(titled(root, "Hydro bill November")).toBe(false);
});
