// SPDX-License-Identifier: AGPL-3.0-only
// The fold matrix (audit v11, slice audit section): the nightly fold of twin pages must never change
// what an assistant reads when the twins are not seen the same way by everyone. For each case (a
// private record, a share_with, an unseen value, an exclude by name, a different sensitivity, an
// open conflict) every agent's read and search answers, for its own token and its reader token,
// are byte-identical before and after upkeep. A plain pair folds, so the matrix isn't vacuous.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { git } from "../src/git";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { upkeep } from "../src/upkeep";
import { loadRules } from "../src/rules";
import { setFoldTwins } from "../src/ownerset";

const KEEP = "projects/garden-planning", DROP = "projects/garden-planning-a1b2c3";
const rec = (value: string, extra: Record<string, unknown> = {}) => ({ value, as_of: "2026-10-02", sources: ["gmail:f000000000000002"], verification: "verified-by-source", by: "planner", recorded: "2026-10-02", ...extra });

type Variant = { keep?: Record<string, unknown>; drop?: Record<string, unknown>; dropFm?: Record<string, unknown>; after?: (root: string) => void };

function rig(v: Variant) {
  const root = makeBrain();
  const page = (id: string, facts: Record<string, unknown>, created: string, fm: Record<string, unknown> = {}) =>
    saveNote(root, { fm: { id, type: "project", title: "Garden planning", area: "work", sensitivity: "personal", status: "active", created, updated: created, by: "planner", facts, ...fm } as never, body: "Planning the garden.", path: "" });
  page(KEEP, { status: rec("active"), ...(v.keep ?? {}) }, "2026-10-01");
  page(DROP, { next_step: rec("Order the cedar boxes"), ...(v.drop ?? {}) }, "2026-10-02", v.dropFm);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "twins"]);
  v.after?.(root);
  return root;
}

async function call(root: string, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return `${res.status} ${await res.text()}`;
}

// Every agent, with its own token and a reader token: read both pages, search the title and values.
async function views(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const agents = Object.keys(loadRules(root).policy.agents ?? {});
  for (const a of agents) for (const role of ["full", "reader"] as const) {
    const token = issueToken(root, a, role === "reader" ? "reader" : undefined);
    for (const [tool, args] of [["read", { id: KEEP }], ["read", { id: DROP }], ["search", { query: "Garden planning" }], ["search", { query: "cedar boxes" }], ["search", { query: "hip surgery" }]] as const)
      out[`${a}/${role} ${tool} ${JSON.stringify(args)}`] = await call(root, token, tool, args as Record<string, unknown>);
  }
  return out;
}

const folded = (root: string) => loadBrain(root).find((n) => n.fm.id === DROP)?.fm.status === "merged";
const HIDDEN = "hip surgery";

// Upkeep runs on two copies of the same brain, one with the fold switched off. Upkeep's other steps
// (the page writer's prose) change both copies alike, so any difference is the fold's.
async function both(v: Variant) {
  const off = rig(v), on = rig(v);
  setFoldTwins(off, "off");
  upkeep(off, { run: "reflect-matrix" });
  upkeep(on, { run: "reflect-matrix" });
  expect(folded(off)).toBe(false);
  return { on, before: await views(off), after: await views(on) };
}

// A pair the fold must leave alone: every answer byte-identical.
async function holds(v: Variant) {
  const { on, before, after } = await both(v);
  expect(folded(on)).toBe(false);
  for (const k of Object.keys(before)) expect(`${k}: ${after[k]}`).toBe(`${k}: ${before[k]}`);
}

// A pair that folds although one record is hidden from some readers by its own flags (G569: the
// flags travel with the record): each reader reads the same facts across the two pages as before,
// and a reader the hidden value never reached still never gets it, in any answer.
const factLines = (views: Record<string, string>, who: string) => new Set(Object.entries(views).filter(([k]) => k.startsWith(`${who} read`)).flatMap(([, t]) => !t.startsWith("200 ") ? [t] : (JSON.parse(t.slice(4)).result?.content ?? []).map((c: { text: string }) => c.text).join("\n").split("\n").filter((l: string) => /^- \*\*/.test(l))));
async function foldsKeepingFlags(v: Variant) {
  const { on, before, after } = await both(v);
  expect(folded(on)).toBe(true);
  const who = [...new Set(Object.keys(before).map((k) => k.split(" ")[0]!))];
  for (const w of who) {
    const saw = Object.entries(before).some(([k, t]) => k.startsWith(`${w} `) && !k.includes(HIDDEN) && t.includes(HIDDEN));
    if (!saw) for (const [k, t] of Object.entries(after)) if (k.startsWith(`${w} `) && !k.includes(HIDDEN)) expect(`${k}: ${t.includes(HIDDEN)}`).toBe(`${k}: false`);
    expect(`${w}: ${[...factLines(after, w)].sort().join(" | ")}`).toBe(`${w}: ${[...factLines(before, w)].sort().join(" | ")}`);
  }
  return { before, after };
}

test("control: a plain pair of twins folds", () => {
  const root = rig({});
  upkeep(root, { run: "reflect-matrix" });
  expect(folded(root)).toBe(true);
});

test("a twin holding a private record: it folds, and nobody gains or loses a fact", async () => {
  const { before } = await foldsKeepingFlags({ drop: { budget: rec("hip surgery fund", { sensitivity: "private" }) } });
  expect(before["steward/full read {\"id\":\"projects/garden-planning-a1b2c3\"}"]).toContain(HIDDEN); // not vacuous: someone reads it
}, 30000);

test("a twin holding a share_with record: it folds, and nobody gains or loses a fact", async () => {
  const { before } = await foldsKeepingFlags({ drop: { budget: rec("hip surgery fund", { share_with: ["steward"] }) } });
  expect(before["steward/full read {\"id\":\"projects/garden-planning-a1b2c3\"}"]).toContain(HIDDEN);
}, 30000);

test("a twin holding an unseen value: it folds, and nobody gains or loses a fact", async () => {
  await foldsKeepingFlags({ drop: { budget: rec("hip surgery fund", { unseen: true }) } });
}, 30000);

test("a twin a rule excludes by name: every view is the same after upkeep", async () => {
  await holds({ after: (root) => {
    const p = join(root, "rules/policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic], exclude_types: [money]", `planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic], exclude_types: [money], exclude: ["${DROP}"]`));
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "exclude"]);
  } });
}, 30000);

test("a twin a rule excludes one fact of by name: every view is the same after upkeep", async () => {
  await holds({ after: (root) => {
    const p = join(root, "rules/policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money]", `helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money], exclude: ["${DROP}#next_step"]`));
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "exclude fact"]);
  } });
}, 30000);

test("twins of different sensitivity: every view is the same after upkeep", async () => {
  await holds({ dropFm: { sensitivity: "private" } });
}, 30000);

test("a twin with an open conflict: every view is the same after upkeep", async () => {
  await holds({ after: (root) => {
    saveNote(root, { fm: { id: "disputes/c-0900", type: "dispute", title: `${KEEP}#status`, area: "work", sensitivity: "personal", status: "open", created: "2026-10-06", updated: "2026-10-06", by: "reflect", fact_key: `${KEEP}#status` } as never, body: "", path: "" });
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "conflict"]);
  } });
}, 30000);

// Harder pairs: the flag on the kept page; the same attribute on both twins, one value hidden (a
// conflict opens; the hidden side keeps its flags); a third page linking to the dropped twin.
test("the kept twin holds the private record: it folds, and nobody gains or loses a fact", async () => {
  await foldsKeepingFlags({ keep: { budget: rec("hip surgery fund", { sensitivity: "private" }) } });
}, 30000);

test("both twins hold the attribute, one value private: nobody reads the hidden value it couldn't", async () => {
  const { on, before, after } = await both({ keep: { budget: rec("seed money") }, drop: { budget: rec("hip surgery fund", { sensitivity: "private" }) } });
  for (const w of new Set(Object.keys(before).map((k) => k.split(" ")[0]!))) {
    const saw = Object.entries(before).some(([k, t]) => k.startsWith(`${w} `) && !k.includes(HIDDEN) && t.includes(HIDDEN));
    if (!saw) for (const [k, t] of Object.entries(after)) if (k.startsWith(`${w} `) && !k.includes(HIDDEN)) expect(`${k}: ${t.includes(HIDDEN)}`).toBe(`${k}: false`);
  }
  if (!folded(on)) for (const k of Object.keys(before)) expect(`${k}: ${after[k]}`).toBe(`${k}: ${before[k]}`);
}, 30000);

test("both twins hold the attribute, one value shared with one assistant: nobody reads the hidden value it couldn't", async () => {
  const { on, before, after } = await both({ keep: { budget: rec("seed money") }, drop: { budget: rec("hip surgery fund", { share_with: ["steward"] }) } });
  for (const w of new Set(Object.keys(before).map((k) => k.split(" ")[0]!))) {
    const saw = Object.entries(before).some(([k, t]) => k.startsWith(`${w} `) && !k.includes(HIDDEN) && t.includes(HIDDEN));
    if (!saw) for (const [k, t] of Object.entries(after)) if (k.startsWith(`${w} `) && !k.includes(HIDDEN)) expect(`${k}: ${t.includes(HIDDEN)}`).toBe(`${k}: false`);
  }
  if (!folded(on)) for (const k of Object.keys(before)) expect(`${k}: ${after[k]}`).toBe(`${k}: ${before[k]}`);
}, 30000);

test("a page linking to the dropped twin, and a private record on it: no hidden value moves", async () => {
  await foldsKeepingFlags({ drop: { budget: rec("hip surgery fund", { sensitivity: "private" }) }, after: (root) => {
    saveNote(root, { fm: { id: "projects/seed-order", type: "project", title: "Seed order", area: "work", sensitivity: "personal", status: "active", created: "2026-10-03", updated: "2026-10-03", by: "planner", facts: { status: rec("active") } } as never, body: `Part of [[${DROP}]].`, path: "" });
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "link"]);
  } });
}, 30000);
