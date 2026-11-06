// SPDX-License-Identifier: AGPL-3.0-only
// Bug hunt 2026-10-15, A1 and A2 (eval gaps G55, G56): a fact hidden from an agent can't be
// probed or changed by its writes, and a carved value doesn't reach it through a note's name.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write, decideProposal } from "../src/write";
import { remember, retire, readNote, search, contextPack } from "../src/core";
import { loadBrain, saveNote } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor, renderPreview } from "../src/carve";
import { renderView } from "../src/view";

const run = (root: string, args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=louis", "-c", "user.email=l@x", ...args]);
const note = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!;
const SRC = { sources: ["gmail:f000000000000002"], verification: "verified-by-source" };

// Steward records a grant code on a work note, shared with steward only: planner (who owns the
// work area and writes there directly) can't see it.
function withHidden(verification = "verified-by-source") {
  const root = makeBrain();
  const sources = verification === "confirmed-by-owner" ? ["owner:2026-09-01/text"] : ["gmail:f000000000000001"];
  const r = write(root, { agent: "steward", id: "projects/course-a", attribute: "grant_code", value: "Falcon-88", as_of: "2026-09-01", sources, verification, share_with: ["steward"] } as never, { acceptedBy: "louis" });
  expect(r.outcome).toBe("committed");
  const rules = loadRules(root);
  expect(carve(loadBrain(root), rules, grantFor(rules, "planner")).hiddenFacts.map((h) => h.key)).toContain("projects/course-a#grant_code");
  return root;
}

test("a write to a hidden fact never changes it: no supersede, no dispute, no merge", () => {
  const root = withHidden();
  const before = JSON.stringify(note(root, "projects/course-a").fm.facts!.grant_code);
  for (const [value, as_of] of [["Osprey-3", "2026-10-05"], ["Heron-12", "2026-08-01"]]) {
    const r = remember(root, "planner", { id: "projects/course-a", attribute: "grant_code", value, as_of, ...SRC });
    expect(r.outcome).toBe("inbox");
  }
  const after = note(root, "projects/course-a").fm;
  expect(JSON.stringify(after.facts!.grant_code)).toBe(before);
  expect(after.history?.grant_code).toBeUndefined();
});

test("the reply to a hidden-fact write is the same whatever the hidden value, date or verification", () => {
  const replies = new Set<string>();
  for (const verification of ["verified-by-source", "confirmed-by-owner"]) {
    for (const [value, as_of] of [["Osprey-3", "2026-10-05"], ["Heron-12", "2026-08-01"], ["Kite-7", "2026-09-01"]]) {
      const root = withHidden(verification);
      const r = remember(root, "planner", { id: "projects/course-a", attribute: "grant_code", value, as_of, ...SRC });
      replies.add(`${r.outcome} ${r.message} ${r.step ?? ""}`);
      expect(r.message).not.toMatch(/Falcon|2026-09-01|dispute|c-\d|supersed|merged|stronger|owner confirmed/i);
    }
  }
  expect([...replies]).toHaveLength(1);
});

test("retiring a hidden fact answers like retiring a missing one", () => {
  const root = withHidden();
  const hidden = retire(root, "planner", { id: "projects/course-a", attribute: "grant_code", value: "ended", as_of: "2026-10-05", ...SRC });
  const missing = retire(root, "planner", { id: "projects/course-a", attribute: "nothing_here", value: "ended", as_of: "2026-10-05", ...SRC });
  expect(hidden.outcome).toBe(missing.outcome);
  expect(hidden.message).toBe(missing.message);
  expect(note(root, "projects/course-a").fm.facts!.grant_code).toBeDefined();
});

test("the owner accepting the proposal still applies it", () => {
  const root = withHidden();
  const req = { agent: "planner", id: "projects/course-a", attribute: "grant_code", value: "Osprey-3", as_of: "2026-10-05", ...SRC };
  expect(remember(root, "planner", req).outcome).toBe("inbox");
  const r = write(root, req as never, { acceptedBy: "louis" });
  expect(r.outcome).toBe("committed");
  const f = note(root, "projects/course-a").fm.facts!.grant_code as { value: string; share_with?: string[] };
  expect(f.value).toBe("Osprey-3");
  expect(f.share_with).toEqual(["steward"]); // the flag stays sticky
});

test("planner still writes a fact it can see on the same note directly", () => {
  const root = withHidden();
  const r = remember(root, "planner", { id: "projects/course-a", attribute: "room", value: "B-210", as_of: "2026-10-05", ...SRC });
  expect(r.outcome).toBe("committed");
});

// ---- A2: names ----

function withNamedNote() {
  const root = makeBrain();
  writeFileSync(join(root, "projects/course-c.md"), `---
id: projects/course-c
type: project
title: Course C (paid via Maple Trust Bank)
aliases: [Maple Trust Bank course]
area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
---
Paid via Maple Trust Bank.
`);
  run(root, ["add", "-A"]); run(root, ["commit", "-qm", "course c"]);
  return root;
}

test("a carved value in a visible note's title or alias is withheld on every read path", () => {
  const root = withNamedNote();
  const n = readNote(root, "planner", "projects/course-c");
  expect(n.title).toBe("Course C (paid via [withheld])");
  expect(n.aliases).toEqual(["[withheld] course"]);
  expect(JSON.stringify(n)).not.toContain("Maple Trust");
  expect(JSON.stringify(search(root, "planner", "course c"))).not.toContain("Maple Trust");
  expect(search(root, "planner", "maple trust").map((h) => h.id)).not.toContain("projects/course-c");
  expect(contextPack(root, "planner", "course c")).not.toContain("Maple Trust");
  const rules = loadRules(root), notes = loadBrain(root);
  expect(renderView(notes, rules, carve(notes, rules, grantFor(rules, "planner")), root)).not.toContain("Maple Trust");
  // The brain keeps the real name, and an agent that holds the value sees it.
  expect(note(root, "projects/course-c").fm.title).toBe("Course C (paid via Maple Trust Bank)");
  expect(readNote(root, "steward", "projects/course-c").title).toBe("Course C (paid via Maple Trust Bank)");
});

test("the owner's preview flags a carved value in a title, alias or id", () => {
  const root = withNamedNote();
  writeFileSync(join(root, "people/maple-trust-bank-teller.md"), `---
id: people/maple-trust-bank-teller
type: person
title: The teller
area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
---
`);
  run(root, ["add", "-A"]); run(root, ["commit", "-qm", "teller"]);
  const rules = loadRules(root), notes = loadBrain(root);
  const res = carve(notes, rules, grantFor(rules, "planner"));
  const flags = res.flags.filter((f) => f.kind === "carved-value-in-view").map((f) => `${f.id}: ${f.detail}`);
  expect(flags.some((f) => f.startsWith("projects/course-c: title or alias"))).toBe(true);
  expect(flags.some((f) => f.startsWith("people/maple-trust-bank-teller: id carries"))).toBe(true);
  expect(renderPreview(notes, res)).toContain("rename the note");
});

test("a new note's id leaves out a value carved from any agent", () => {
  const root = makeBrain();
  const w = remember(root, "steward", { title: "Joe at Maple Trust Bank", type: "person", area: "personal", attribute: "role", value: "Teller", as_of: "2026-10-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(w.outcome).toBe("committed");
  const joe = loadBrain(root).find((n) => n.fm.title === "Joe at Maple Trust Bank")!;
  expect(joe.fm.id).toMatch(/^people\/joe-[0-9a-f]{6}$/); // every new note gets a suffix (G28)
  const hits = search(root, "planner", "Joe teller");
  expect(hits.map((h) => h.id)).toContain(joe.fm.id);
  expect(JSON.stringify(hits)).not.toContain("Maple");
  // Ordinary titles keep their usual slug, with the suffix every new note gets (G28).
  const plain = remember(root, "steward", { title: "Ana Silva", type: "person", area: "personal", attribute: "role", value: "Chef", as_of: "2026-10-01", sources: ["gmail:f00000000000000a"], verification: "verified-by-source" });
  expect(plain.outcome).toBe("committed");
  expect(loadBrain(root).some((n) => /^people\/ana-silva-[0-9a-f]{6}$/.test(n.fm.id))).toBe(true);
});

// ---- slice audit of the branch: guesses, shown names, disguised spellings ----

// Course D's sponsor is hidden from planner by name in its grant (no tripwire covers it), and its
// title names the sponsor.
function withSponsor() {
  const root = makeBrain();
  writeFileSync(join(root, "projects/course-d.md"), `---
id: projects/course-d
type: project
title: Course D (sponsored by Bluefin Holdings)
area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  sponsor: { value: Bluefin Holdings, as_of: 2026-10-01, sources: ["gmail:f000000000000004"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
---
`);
  const policy = join(root, "rules/policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("exclude_types: [money] }", "exclude_types: [money], exclude: [projects/course-d#sponsor] }"));
  run(root, ["add", "-A"]); run(root, ["commit", "-qm", "course d"]);
  return root;
}
const by = (title: string, attribute = "room") => ({ title, type: "project", area: "work", attribute, value: "B-210", as_of: "2026-10-05", ...SRC });

test("a by-title write can't land on a note by guessing its withheld word; the guess trips the leak wire", () => {
  const root = withSponsor();
  expect(readNote(root, "planner", "projects/course-d").title).toBe("Course D (sponsored by [withheld])");
  // The miss first: once a core assistant's guess trips the wire, all its writes go to the owner (G680).
  const wrong = remember(root, "planner", by("Course D (sponsored by Redfin Partners)"));
  const right = remember(root, "planner", by("Course D (sponsored by Bluefin Holdings)"));
  expect(right.outcome).toBe("refused");
  expect(right.message).toMatch(/^leak_tripwire: the title/);
  expect(right.message).not.toMatch(/course-d|sponsor/);
  expect(wrong.fact_key).toMatch(/^projects\/course-d-sponsored-by-redfin-partners-[0-9a-f]{6}#room$/);
  expect(note(root, "projects/course-d").fm.facts?.room).toBeUndefined();
  // A disguised spelling is refused too, so the guess can't be read back as [withheld].
  expect(remember(withSponsor(), "planner", by("Zed from Bluefin-Holdings")).outcome).toBe("refused");
});

test("names keep innocent words that only share a fragment with a carved value", () => {
  const root = makeBrain();
  for (const [id, title] of [["projects/tb", "Trust Banking 101"], ["projects/mt", "Maple Trust Bankers club"]])
    writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: project\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  run(root, ["add", "-A"]); run(root, ["commit", "-qm", "x"]);
  expect(readNote(root, "planner", "projects/tb").title).toBe("Trust Banking 101");
});

test("writing by the title an agent is shown lands on that note, not a copy", () => {
  const root = withNamedNote();
  const before = loadBrain(root).length;
  const a = remember(root, "planner", by("Course C (paid via [withheld])", "next_step"));
  const b = remember(root, "planner", by("[withheld] course", "room"));
  expect(a.fact_key).toBe("projects/course-c#next_step");
  expect(b.fact_key).toBe("projects/course-c#room");
  expect(loadBrain(root).length).toBe(before);
  expect(note(root, "projects/course-c").fm.title).toBe("Course C (paid via Maple Trust Bank)");
});

test("a disguised spelling of a carved value is withheld in names, flagged, and left out of new ids", () => {
  const root = makeBrain();
  for (const [id, title] of [["people/ana", "Ana at Maple-Trust Bank"], ["people/bo", "Bo at MAPLE  TRUST  BANK"], ["people/cy", "Cy at Mapletrust Bank"]])
    writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n---\n`);
  run(root, ["add", "-A"]); run(root, ["commit", "-qm", "people"]);
  for (const id of ["people/ana", "people/bo", "people/cy"]) {
    const n = readNote(root, "planner", id);
    expect(n.title).toMatch(/^\w+ at \[withheld\]$/);
  }
  expect(search(root, "planner", "mapletrust").length).toBe(0);
  const rules = loadRules(root), notes = loadBrain(root);
  expect(carve(notes, rules, grantFor(rules, "planner")).flags.filter((f) => f.detail.startsWith("title or alias")).map((f) => f.id).sort()).toEqual(["people/ana", "people/bo", "people/cy"]);
  const w = remember(root, "steward", { title: "Joe at Maple-Trust Bank", type: "person", area: "personal", attribute: "role", value: "Teller", as_of: "2026-10-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(w.fact_key).toMatch(/^people\/joe-[0-9a-f]{6}#role$/);
});

test("a title with no Latin letters still gets a real id (bug hunt A8)", () => {
  const root = makeBrain();
  const base = { type: "person", area: "personal", attribute: "role", value: "Friend", as_of: "2026-10-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" };
  const a = remember(root, "steward", { ...base, title: "山田太郎" });
  const b = remember(root, "steward", { ...base, title: "Иван Петров" });
  expect([a.outcome, b.outcome]).toEqual(["committed", "committed"]);
  const byTitle = new Map(loadBrain(root).map((n) => [n.fm.title, n.fm.id]));
  const ids = ["山田太郎", "Иван Петров"].map((t) => byTitle.get(t)!).filter(Boolean);
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^people\/note-[0-9a-f]{6}-[0-9a-f]{6}$/);
  expect(new Set(ids).size).toBe(2);
  expect(readNote(root, "steward", ids[0]).title).toBe("山田太郎");
});

// ---- rebase audit: a fact an agent shared away from itself ----

function plannerShared() {
  const root = makeBrain();
  const r = remember(root, "planner", { id: "projects/course-a", attribute: "grant_code", value: "Falcon-88", as_of: "2026-09-01", share_with: ["steward"], ...SRC });
  expect(r.outcome).toBe("committed");
  expect((note(root, "projects/course-a").fm.facts!.grant_code as { shared_by?: string }).shared_by).toBe("planner");
  return root;
}
// The owner editing the file by hand: the record keeps `by: planner`.
function ownerEdit(root: string, change: (r: Record<string, unknown>) => void) {
  const n = note(root, "projects/course-a");
  change(n.fm.facts!.grant_code as unknown as Record<string, unknown>);
  saveNote(root, n);
  run(root, ["commit", "-qam", "owner edit"]);
}
const next = { id: "projects/course-a", attribute: "grant_code", value: "Osprey-3", as_of: "2026-10-05", sources: ["gmail:f000000000000003"], verification: "verified-by-source" };

test("an agent that shared its own fact away can keep writing it", () => {
  expect(remember(plannerShared(), "planner", next).outcome).toBe("committed");
});

test("a share_with the owner added by hand keeps the agent's own fact out of its reach", () => {
  const root = makeBrain();
  expect(remember(root, "planner", { id: "projects/course-a", attribute: "grant_code", value: "Falcon-88", as_of: "2026-09-01", ...SRC }).outcome).toBe("committed");
  ownerEdit(root, (r) => { r.share_with = ["steward"]; });
  expect(note(root, "projects/course-a").fm.facts!.grant_code).toMatchObject({ share_with: ["steward"], by: "planner" });
  const r = remember(root, "planner", next);
  expect(r.outcome).toBe("inbox");
  expect((note(root, "projects/course-a").fm.facts!.grant_code as { value: string }).value).toBe("Falcon-88");
});

test("once the owner confirms the value, the agent's shared-away fact is out of its reach", () => {
  const root = plannerShared();
  ownerEdit(root, (r) => { r.verification = "confirmed-by-owner"; });
  const r = remember(root, "planner", next);
  expect(r.outcome).toBe("inbox");
  expect(r.message).not.toMatch(/owner confirmed|disput/);
});

test("once the owner accepts another agent's proposal into it, the agent's shared-away fact is out of its reach", () => {
  const root = plannerShared();
  // Claiming the owner's word outside its area, steward's fact still waits for the owner (G422).
  const p = remember(root, "steward", { id: "projects/course-a", attribute: "grant_code", value: "Falcon-88", as_of: "2026-08-20", sources: ["gmail:f000000000000004", "owner:2026-08-20/text"], verification: "confirmed-by-owner" });
  expect(p.outcome).toBe("inbox");
  expect(decideProposal(root, p.file!, "accept").outcome).toBe("committed");
  const r = remember(root, "planner", next);
  expect(r.outcome).toBe("inbox");
  expect(r.message).not.toMatch(/conflict|disput/);
  expect((note(root, "projects/course-a").fm.facts!.grant_code as { value: string }).value).toBe("Falcon-88");
});

test("another writer merging the same value into it puts the agent's shared-away fact out of its reach", () => {
  const root = plannerShared();
  const policy = join(root, "rules/policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8") + "\nowner_editor: steward\n");
  run(root, ["commit", "-qam", "owner sets an editor"]);
  const m = remember(root, "steward", { id: "projects/course-a", attribute: "grant_code", value: "Falcon-88", as_of: "2026-08-20", sources: ["gmail:f000000000000004"], verification: "verified-by-source" });
  expect(m.outcome).toBe("committed");
  const r = remember(root, "planner", next);
  expect(r.outcome).toBe("inbox");
  expect(r.message).not.toMatch(/2026-08-20|supersed/);
  expect((note(root, "projects/course-a").fm.facts!.grant_code as { value: string }).value).toBe("Falcon-88");
});

test("another writer citing the same source with an earlier date also puts the shared-away fact out of reach", () => {
  const root = plannerShared();
  const policy = join(root, "rules/policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8") + "\nowner_editor: steward\n");
  run(root, ["commit", "-qam", "owner sets an editor"]);
  expect(remember(root, "steward", { id: "projects/course-a", attribute: "grant_code", value: "Falcon-88", as_of: "2026-08-20", ...SRC }).outcome).toBe("committed");
  const r = remember(root, "planner", next);
  expect(r.outcome).toBe("inbox");
  expect(r.message).not.toMatch(/2026-08-20|supersed/);
});

// Audit v9 (2026-10-31; G584): a merge folding an owner-set share into the agent's own shared-away
// record kept the agent's shared_by, so the owner's narrower share looked like the agent's own
// (invariant 4) and the agent's next write went from inbox to disputed.
test("a merge never makes an owner-set share look like the agent's own (G584)", async () => {
  const { planMerge } = await import("../src/merge");
  const root = plannerShared();
  const keep = note(root, "projects/course-a");
  const drop = structuredClone(keep);
  drop.fm.id = "projects/course-a-copy";
  drop.path = "projects/course-a-copy.md";
  // The owner's own share, set by hand on the planner's record: no shared_by.
  const rec = drop.fm.facts!.grant_code as unknown as Record<string, unknown>;
  rec.share_with = [];
  delete rec.shared_by;
  drop.fm.facts = { grant_code: rec } as never;
  const { keep: merged } = planMerge(keep, drop, () => "c-0");
  const g = merged.fm.facts!.grant_code as { share_with?: string[]; shared_by?: string };
  expect(g.share_with).toEqual([]);
  expect(g.shared_by).toBeUndefined();
  saveNote(root, merged);
  run(root, ["commit", "-qam", "owner: merge"]);
  expect(remember(root, "planner", next).outcome).toBe("inbox");
});

// Slice audit of claude/audit9-fixes (2026-10-31; G584 follow-up): settling a conflict narrowed the
// chosen side's share_with by the other side's list and kept the chosen side's shared_by, the same
// look-alike own share the merge made.
test("settling a conflict never makes a share narrowed by another side look like the chosen agent's own (G584)", async () => {
  const { ownerDecide } = await import("../src/core");
  const root = plannerShared();
  const w = write(root, { agent: "steward", kind: "fact", id: "projects/course-a", attribute: "grant_code", value: "Osprey-3", as_of: "2026-09-01", sources: ["gcal:e5@e5"], verification: "self-reported", share_with: [] } as never, { acceptedBy: "auto-decide", contest: true });
  expect(w.outcome).toBe("disputed");
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  const cands = packet.fm.candidates as { value: string }[];
  ownerDecide(root, String(packet.fm.id).split("/")[1]!, cands.findIndex((c) => c.value === "Falcon-88") + 1);
  const g = note(root, "projects/course-a").fm.facts!.grant_code as { value: string; share_with?: string[]; shared_by?: string };
  expect(g.value).toBe("Falcon-88");
  expect(g.share_with).toEqual([]);
  expect(g.shared_by).toBeUndefined();
  expect(remember(root, "planner", next).outcome).toBe("inbox");
});
