// SPDX-License-Identifier: AGPL-3.0-only
// Person identity merge (docs/same-person.md): two person notes that share a trusted address
// become one "same person?" proposal with its evidence; nothing merges until the owner says so,
// and every merge can be undone.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { samePersonProposals, mergeSamePerson, notSamePerson, undoPersonMerge, personMerges } from "../src/sameperson";
import { setStanding, loadStanding } from "../src/standing";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { recordCheckedRefs } from "../src/louis";
import { mergeNotes, planMerge } from "../src/merge";
import { upkeep } from "../src/upkeep";

const rec = (value: string, src: string, verification = "verified-by-source") =>
  `{ value: "${value}", as_of: 2026-09-01, sources: ["${src}"], verification: ${verification}, by: planner, recorded: 2026-10-01 }`;
function person(root: string, id: string, title: string, facts: Record<string, string[]>, o: { sensitivity?: string; created?: string; aliases?: string[]; area?: string; tags?: string[] } = {}) {
  const lines = Object.entries(facts).map(([a, items]) => `  ${a}: { items: [${items.join(", ")}] }`).join("\n");
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${title}\n${o.aliases ? `aliases: [${o.aliases.join(", ")}]\n` : ""}area: ${o.area ?? "work"}\nsensitivity: ${o.sensitivity ?? "personal"}\n${o.tags ? `tags: [${o.tags.join(", ")}]\n` : ""}status: active\ncreated: ${o.created ?? "2026-10-03"}\nupdated: 2026-10-03\nby: planner\nfacts:\n${lines}\n---\nMet through the course.\n`);
}
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: root }); };
// Jane Roy (people/jane-roy, phone +15145550100 from gmail …01) and a second note made by a text pull.
function split(phone = rec("(514) 555-0100", "imsg:phonemsg-77"), extra: Record<string, string[]> = {}, o = {}) {
  const root = makeBrain();
  person(root, "people/j-roy", "J. Roy", { phones: [phone], ...extra }, o);
  commit(root);
  return root;
}
const note = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!;
const file = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8");

test("two person notes sharing a trusted phone become one proposal with the refs from both sides", () => {
  const root = split();
  const ps = samePersonProposals(root);
  expect(ps.length).toBe(1);
  const p = ps[0];
  expect([p.keep, p.drop].sort()).toEqual(["people/j-roy", "people/jane-roy"]);
  expect(p.keep).toBe("people/jane-roy"); // the older note keeps its history
  expect(p.score).toBeGreaterThanOrEqual(0.9);
  expect(p.evidence).toMatchObject([{ kind: "phone", address: "+15145550100", refs: ["gmail:f000000000000001", "imsg:phonemsg-77"], added_by: ["planner"] }]);
});

test("no proposal from a self-reported or ended address, from a name alone, or below the bar", () => {
  expect(samePersonProposals(split(rec("+15145550100", "agent:planner", "self-reported")))).toEqual([]);
  expect(samePersonProposals(split(rec("+15145550100", "imsg:phonemsg-77").replace(" }", ", valid_to: 2026-09-20 }")))).toEqual([]);
  const root = makeBrain();
  person(root, "people/jane-roy-2", "Jane Roy", { phones: [rec("+15145550199", "imsg:phonemsg-78")] }, { aliases: ["Jane"] });
  commit(root);
  expect(samePersonProposals(root)).toEqual([]);
  // A shared handle alone (0.7) is below the bar; with a matching name (0.8) still below.
  const h = makeBrain();
  person(h, "people/a", "Jane Roy", { handles: [rec("discord:JRoy", "discord:111/1@1")] });
  person(h, "people/b", "J R", { handles: [rec("discord:jroy", "discord:111/2@1")] });
  commit(h);
  expect(samePersonProposals(h)).toEqual([]);
});

test("a private note's card shows no address; the proposal still says why", () => {
  const root = split(undefined, {}, { sensitivity: "private" });
  const [p] = samePersonProposals(root);
  expect(p.private).toBe(true);
  expect(p.card).not.toContain("5550100");
  expect(p.card).toContain("a private note shares a phone number");
});

test("nothing merges until the owner says so; merge then undo puts both notes back exactly", () => {
  const root = split();
  const before = { a: file(root, "people/jane-roy"), b: file(root, "people/j-roy") };
  expect(note(root, "people/j-roy").fm.status).toBe("active");
  const [p] = samePersonProposals(root);
  const msg = mergeSamePerson(root, p.id);
  expect(msg).toContain("merged people/j-roy into people/jane-roy");
  expect(note(root, "people/j-roy").fm.status).toBe("merged");
  expect(personMerges(root).map((m) => m.id)).toEqual([p.id]);
  expect(samePersonProposals(root)).toEqual([]);
  undoPersonMerge(root, p.id);
  expect(file(root, "people/jane-roy")).toBe(before.a);
  expect(file(root, "people/j-roy")).toBe(before.b);
  // An undone pair is the owner's "not the same": never proposed again for the same evidence.
  expect(samePersonProposals(root)).toEqual([]);
});

test("swap keeps the other note", () => {
  const root = split();
  const [p] = samePersonProposals(root);
  mergeSamePerson(root, p.id, { swap: true });
  expect(note(root, "people/jane-roy").fm.status).toBe("merged");
  expect(note(root, "people/jane-roy").fm.merged_into).toBe("people/j-roy");
});

test("undo refuses when a later commit touched either note, and says so", () => {
  const root = split();
  const [p] = samePersonProposals(root);
  mergeSamePerson(root, p.id);
  const f = join(root, "people/jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("Coordinates", "Still coordinates"));
  Bun.spawnSync(["git", "commit", "-qam", "later edit"], { cwd: root });
  expect(() => undoPersonMerge(root, p.id)).toThrow(/changed since the merge/);
  expect(note(root, "people/j-roy").fm.status).toBe("merged");
});

test("not the same: never proposed again until a new shared address appears", () => {
  const root = split();
  const [p] = samePersonProposals(root);
  notSamePerson(root, p.id);
  expect(samePersonProposals(root)).toEqual([]);
  const f = join(root, "people/j-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("  phones:", `  emails: { items: [${rec("jane@northfield.example", "gmail:f000000000000003")}] }\n  phones:`));
  const j = join(root, "people/jane-roy.md");
  writeFileSync(j, readFileSync(j, "utf8").replace("  phones:", `  emails: { items: [${rec("Jane@Northfield.example", "gmail:f000000000000001")}] }\n  phones:`));
  commit(root);
  expect(samePersonProposals(root).length).toBe(1);
});

test("standing follows the person; two different standing entries refuse the merge", () => {
  const root = split();
  setStanding(root, "people/j-roy", "close");
  const [p] = samePersonProposals(root);
  expect(p.keep).toBe("people/j-roy"); // the note with standing is kept by default
  mergeSamePerson(root, p.id, { swap: true }); // keeping the other moves the standing with the person
  const s = loadStanding(root).people;
  expect(s["people/jane-roy"]?.tier).toBe("close");
  expect(s["people/j-roy"]).toBeUndefined();
  undoPersonMerge(root, p.id);
  expect(loadStanding(root).people["people/j-roy"]?.tier).toBe("close");

  const r2 = split();
  setStanding(r2, "people/j-roy", "close");
  setStanding(r2, "people/jane-roy", "known");
  const [q] = samePersonProposals(r2);
  expect(() => mergeSamePerson(r2, q.id)).toThrow(/standing/);
  expect(note(r2, "people/j-roy").fm.status).toBe("active");
});

test("a stale proposal id is refused rather than merging something else", () => {
  const root = split();
  expect(() => mergeSamePerson(root, "sp-000000000000")).toThrow(/no proposal/);
  expect(existsSync(join(root, "log", "people", "merges.jsonl"))).toBe(false);
  expect(YAML.parse("a: 1")).toEqual({ a: 1 });
});

// ---------- the dashboard and the CLI ----------
async function dash(root: string) {
  const H = "127.0.0.1:8793";
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/people`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    const loc = r.headers.get("location") ?? "";
    return { status: r.status, text: await r.text(), ...flashOf(loc) };
  };
  const post = async (action: string, fields: Record<string, string>) => {
    const csrf = (await req("GET", "/people")).text.match(/name="csrf" value="([^"]+)"/)![1];
    return req("POST", `/action/${action}`, { csrf, ...fields });
  };
  return { req, post };
}

test("the Who matters page asks 'Same person?' with the evidence; Merge, then Undo, each one click", async () => {
  const root = split();
  const { req, post } = await dash(root);
  const [p] = samePersonProposals(root);
  const page = (await req("GET", "/people")).text;
  expect(page).toContain("Same person?");
  expect(page).toContain("+15145550100");
  expect(page).toContain("imsg:phonemsg-77");
  expect(note(root, "people/j-roy").fm.status).toBe("active"); // opening the page merges nothing
  const m = await post("same-person-merge", { id: p.id });
  expect(m.ok).toContain("merged people/j-roy into people/jane-roy");
  expect((await req("GET", "/people")).text).toContain("same-person-undo");
  const u = await post("same-person-undo", { id: p.id });
  expect(u.ok).toContain("both notes are back");
  expect(note(root, "people/j-roy").fm.status).toBe("active");
});

test("Not the same hides the pair; a stale id is an error flash, not a merge", async () => {
  const root = split();
  const { req, post } = await dash(root);
  const [p] = samePersonProposals(root);
  expect((await post("same-person-not", { id: p.id })).ok).toContain("stay apart");
  expect((await req("GET", "/people")).text).not.toContain("same-person-merge");
  expect((await post("same-person-merge", { id: p.id })).err).toContain("no proposal");
});

test("pocketbrain same-person lists the proposal and merges by id", () => {
  const root = split();
  const cli = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...a, "--brain", root], { env: { ...process.env, PB_TODAY: "2026-10-08" } });
  const out = cli("same-person").stdout.toString();
  const [p] = samePersonProposals(root);
  expect(out).toContain(p.id);
  expect(out).toContain("Same person? Jane Roy and J. Roy");
  expect(cli("same-person", "merge", p.id).exitCode).toBe(0);
  expect(note(root, "people/j-roy").fm.status).toBe("merged");
});

test("an address whose only source the connector found missing never counts", () => {
  const root = split(rec("+15145550100", "gmail:f0000000000000aa"));
  expect(samePersonProposals(root).length).toBe(1);
  recordCheckedRefs(root, { "gmail:f0000000000000aa": false });
  expect(samePersonProposals(root)).toEqual([]);
});

test("the card names who wrote each side's address", () => {
  const [p] = samePersonProposals(split());
  expect(p.evidence[0]).toMatchObject({ added_by: ["planner"] });
});

// ---------- slice audit of claude/person-merge ----------

test("a standing entry left from an earlier note under the same id never comes back through a merge", () => {
  const root = split();
  // The owner placed an earlier people/j-roy (created 2020); this j-roy is a new note under that id.
  writeFileSync(join(root, "rules", "standing.yaml"), "people:\n  people/j-roy: { tier: inner, addresses: ['+15145550100'], note_created: '2020-01-01' }\n");
  commit(root);
  const [p] = samePersonProposals(root);
  expect(p.card).not.toContain("standing");
  mergeSamePerson(root, p.id);
  const raw = readFileSync(join(root, "rules", "standing.yaml"), "utf8");
  expect(raw).not.toContain("people/jane-roy");
  expect(loadStanding(root).people["people/jane-roy"]).toBeUndefined();
});

test("on a replica a merge is refused before anything is written", () => {
  const root = split();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {}, laptop: {} }\n");
  commit(root);
  Bun.spawnSync(["git", "config", "--local", "pocketbrain.replica", "laptop"], { cwd: root });
  const [p] = samePersonProposals(root);
  expect(() => mergeSamePerson(root, p.id)).toThrow(/replica/);
  expect(Bun.spawnSync(["git", "status", "--porcelain", "--", ".", ":!log"], { cwd: root }).stdout.toString().trim()).toBe("");
});

test("the same standing on both notes keeps both notes' pinned addresses", () => {
  const root = split();
  writeFileSync(join(root, "rules", "standing.yaml"), "people:\n  people/j-roy: { tier: close, addresses: ['+15145550100'], note_created: '2026-10-03' }\n  people/jane-roy: { tier: close, addresses: ['jane@northfield.example'], note_created: '2026-10-01' }\n");
  commit(root);
  const [p] = samePersonProposals(root);
  mergeSamePerson(root, p.id);
  expect(loadStanding(root).people["people/jane-roy"]?.addresses?.sort()).toEqual(["+15145550100", "jane@northfield.example"]);
});

test("the note with standing is kept by default, the card says standing moves only when it does, and evidence is per note", () => {
  const root = split(undefined, {}, { created: "2026-09-01" }); // the new note is older
  setStanding(root, "people/jane-roy", "close");
  const [p] = samePersonProposals(root);
  expect(p.keep).toBe("people/jane-roy");
  expect(p.evidence[0].on).toEqual({ "people/jane-roy": { refs: ["gmail:f000000000000001"], added_by: ["planner"] }, "people/j-roy": { refs: ["imsg:phonemsg-77"], added_by: ["planner"] } });
  expect(p.card).not.toContain("standing");
  const r2 = split();
  setStanding(r2, "people/j-roy", "close");
  const [q] = samePersonProposals(r2);
  expect(q.keep).toBe("people/j-roy");
  const r3 = split(undefined, {}, { created: "2026-09-01" });
  setStanding(r3, "people/jane-roy", "close");
  const [x] = samePersonProposals(r3);
  // Keeping the other way would move the standing: the card says so.
  expect(x.swap_moves_standing).toBe(true);
}, 30_000); // three brains: about 5 s under a full-suite load, past bun's default

test("a merge whose commit fails leaves no dispute file behind", () => {
  const root = split(undefined, { role: [] });
  // The two notes disagree on role, so the merge opens a dispute; then the commit fails.
  const f = join(root, "people/j-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("  role: { items: [] }\n", `  role: ${rec("Teacher", "imsg:phonemsg-77")}\n`));
  commit(root);
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  Bun.spawnSync(["chmod", "+x", hook]);
  const [p] = samePersonProposals(root);
  expect(() => mergeSamePerson(root, p.id)).toThrow();
  expect(Bun.spawnSync(["git", "status", "--porcelain", "--", ".", ":!log"], { cwd: root }).stdout.toString().trim()).toBe("");
});

// ---------- red team 2026-10-16 (G150-G155) ----------
const status = (root: string) => Bun.spawnSync(["git", "status", "--porcelain", "--", ".", ":!log"], { cwd: root }).stdout.toString().trim();
const cliIn = (root: string, ...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...a, "--brain", root], { env: { ...process.env, PB_TODAY: "2026-10-08" } });

test("notes in different areas are still asked about, but can't merge: the card says why and offers no Merge (G150)", async () => {
  const root = split(undefined, {}, { area: "personal" });
  const [p] = samePersonProposals(root);
  expect(p.blocked).toBe("the notes are in different areas (personal, work); move one first");
  expect(p.swap_blocked).toBe(p.blocked);
  expect(p.card).toContain("Can't merge here: the notes are in different areas (personal, work); move one first.");
  const { req, post } = await dash(root);
  const page = (await req("GET", "/people")).text;
  expect(page).toContain("Can't merge here: the notes are in different areas (personal, work)");
  expect(page).not.toContain("same-person-merge");
  expect(page).toContain("same-person-not");
  expect((await post("same-person-merge", { id: p.id })).err).toContain("different areas");
  expect(note(root, "people/j-roy").fm.status).toBe("active");
  expect(status(root)).toBe("");
  const out = cliIn(root, "same-person").stdout.toString();
  expect(out).toContain("Can't merge here: the notes are in different areas");
  expect(out).not.toContain(`same-person merge ${p.id}`);
  // The plain duplicate merge refuses too.
  expect(mergeNotes(root, "people/jane-roy", "people/j-roy").message).toContain("different areas");
});

test("an exclude naming the dropped note, in policy or a slice, refuses the merge before anything is written (G151, G152)", () => {
  const root = split();
  const sl = join(root, "rules/slices.yaml");
  writeFileSync(sl, readFileSync(sl, "utf8").replace("contacts-basic:", "contacts-basic:\n    exclude: [\"people/j-roy#phones\"]"));
  commit(root);
  const [p] = samePersonProposals(root);
  expect(p.blocked).toContain("slice contacts-basic");
  // Keeping j-roy instead is refused too: the exclude makes contacts-basic see the notes differently.
  expect(p.swap_blocked).toContain("see one of these notes but not the other");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here: your rules hide J. Roy/);
  expect(() => mergeSamePerson(root, p.id, { swap: true })).toThrow(/make their access the same first/);
  expect(status(root)).toBe("");
  expect(existsSync(join(root, "log", "people", "merges.jsonl"))).toBe(false);

  const r2 = split();
  const pol = join(r2, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("exclude_types: [money] }\n  # Keeps", "exclude_types: [money], exclude: [people/j-roy] }\n  # Keeps"));
  commit(r2);
  const [q] = samePersonProposals(r2);
  expect(q.blocked).toContain("planner's exclude in policy.yaml");
  expect(() => mergeSamePerson(r2, q.id)).toThrow(/change the exclude first/);
  expect(note(r2, "people/j-roy").fm.status).toBe("active");
});

test("a more private dropped note's tags stay behind with its names (G153)", () => {
  // Today a private note and a personal one are seen differently, so the merge is refused outright;
  // the merge built in memory still holds the tags back with the names.
  const root = split(undefined, {}, { sensitivity: "private", tags: ["family"] });
  const [p] = samePersonProposals(root);
  expect(() => mergeSamePerson(root, p.id)).toThrow(/make their access the same first/);
  const plan = planMerge(note(root, "people/jane-roy"), note(root, "people/j-roy"), () => "c-x");
  expect(plan.r.tagsHeld).toEqual(["family"]);
  expect(plan.keep.fm.tags ?? []).not.toContain("family");
  // At the same level the tags move as before.
  const r2 = split(undefined, {}, { tags: ["family"] });
  mergeSamePerson(r2, samePersonProposals(r2)[0].id);
  expect(note(r2, "people/jane-roy").fm.tags).toContain("family");
});

test("undo also reverts upkeep's link repoints, and any other later change still refuses (G154)", () => {
  const root = split(rec("(514) 555-0100", "gmail:f000000000000001")); // Jane's ref, so upkeep's recheck leaves both notes alone
  const c = join(root, "projects/course-a.md");
  writeFileSync(c, readFileSync(c, "utf8").replace("Course logistics.", "Course logistics. TA is [[people/j-roy]]."));
  commit(root);
  const files = () => ["projects/course-a.md", "people/jane-roy.md", "people/j-roy.md"].map((f) => readFileSync(join(root, f), "utf8"));
  const before = files();
  const [p] = samePersonProposals(root);
  mergeSamePerson(root, p.id);
  upkeep(root, { now: "2026-10-08" });
  expect(readFileSync(c, "utf8")).toContain("[[people/jane-roy]]");
  expect(undoPersonMerge(root, p.id)).toContain("1 link repoint");
  expect(files()).toEqual(before);
  expect(status(root)).toBe("");

  const r2 = split();
  const [q] = samePersonProposals(r2);
  mergeSamePerson(r2, q.id);
  const j = join(r2, "people/jane-roy.md");
  writeFileSync(j, readFileSync(j, "utf8").replace("  phones:", "  role2: { value: x, as_of: 2026-10-01, sources: [\"gmail:f000000000000001\"] }\n  phones:"));
  Bun.spawnSync(["git", "commit", "-qam", "later edit"], { cwd: r2 });
  expect(() => undoPersonMerge(r2, q.id)).toThrow(/changed since the merge/);
});

test("an open dispute on a list item of either note blocks the merge (G155)", () => {
  const root = split(undefined, { kids: [rec("Max", "imsg:phonemsg-77").replace(" }", ", dispute: c-0042 }")] });
  const [p] = samePersonProposals(root);
  expect(p.blocked).toBe("J. Roy's kids is disputed; settle it first");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/settle it first/);
  expect(() => mergeSamePerson(root, p.id, { swap: true })).toThrow(/settle it first/);
  expect(note(root, "people/j-roy").fm.status).toBe("active");
  expect(status(root)).toBe("");
});

test("undo looks only at this pair's standing: someone else's entry changing since doesn't block it, this pair's does", () => {
  const root = split();
  setStanding(root, "people/j-roy", "close");
  const [p] = samePersonProposals(root);
  mergeSamePerson(root, p.id, { swap: true }); // the standing moves to jane-roy
  setStanding(root, "people/paul-advisor", "known");
  expect(undoPersonMerge(root, p.id)).toContain("both notes are back");
  expect(loadStanding(root).people["people/j-roy"]?.tier).toBe("close");
  expect(loadStanding(root).people["people/paul-advisor"]?.tier).toBe("known");
  expect(status(root)).toBe("");
  expect(existsSync(join(root, ".git", "sequencer"))).toBe(false);

  const r2 = split();
  setStanding(r2, "people/j-roy", "close");
  const [q] = samePersonProposals(r2);
  mergeSamePerson(r2, q.id, { swap: true });
  setStanding(r2, "people/jane-roy", "inner");
  expect(() => undoPersonMerge(r2, q.id)).toThrow(/changed since the merge/);
});
