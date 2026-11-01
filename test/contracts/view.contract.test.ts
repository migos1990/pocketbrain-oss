// SPDX-License-Identifier: AGPL-3.0-only
// Contract for src/view.ts: what text an agent receives from its carve (links redacted, carved
// values withheld, no other agent named). A bug fixed in view.ts adds a row here.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeBrain } from "../fixture";
import { loadBrain } from "../../src/brain";
import { loadRules } from "../../src/rules";
import { carve, grantFor } from "../../src/carve";
import { redactLinks, scrubCarved, statusBanner, renderNote, renderView, buildView } from "../../src/view";
import { readNote } from "../../src/core";
import { useCells } from "../../src/cell";

const SRC = `sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-01`;
function note(root: string, id: string, fm: string, facts = "", body = "") {
  const p = join(root, `${id}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\nid: ${id}\ntitle: ${id}\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n${fm}\n${facts ? `facts:\n${facts}\n` : ""}---\n${body}\n`);
}
function setup(agent = "helper", slices?: string[], extra?: (root: string) => void) {
  const root = makeBrain();
  extra?.(root);
  const notes = loadBrain(root), rules = loadRules(root);
  return { root, notes, rules, res: carve(notes, rules, grantFor(rules, agent, slices)) };
}

test("contract view: a link to a note outside the view is [[redacted]], hidden or missing alike (invariant 3)", () => {
  const { res } = setup();
  const rows: [string, string][] = [
    ["[[projects/course-a]]", "[[projects/course-a]]"],
    ["[[projects/course-a|A]]", "[[projects/course-a|A]]"],
    ["[[money/main-bank]]", "[[redacted]]"],
    ["[[money/main-bank|the bank]]", "[[redacted]]"], // the label could name it
    ["[[money/main-bank#cards]]", "[[redacted]]"],
    ["[[ money/main-bank ]]", "[[redacted]]"],
    ["[[money/no-such]]", "[[redacted]]"], // a missing note looks the same as a hidden one
  ];
  for (const [input, out] of rows) expect(redactLinks(input, res), input).toBe(out);
});

test("contract view: a carved value is withheld from prose, disguised or not", () => {
  const { res } = setup("helper", undefined, (root) =>
    note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active", `  city: { value: Phoenix, as_of: 2026-10-01, sensitivity: private, ${SRC} }`));
  const rows: [input: string, deep: boolean, out: string][] = [
    ["Paid through Maple Trust Bank.", true, "Paid through [withheld]."],
    ["paid through maple trust bank", true, "paid through [withheld]"], // case-insensitive
    ["- Paid via Maple-Trust-Bank\nnext line", true, "- [withheld]\nnext line"], // disguised: the whole line goes
    ["Paid via M a p l e  Trust Bank", true, "[withheld]"],
    ["Moving to Phoenix soon", true, "Moving to [withheld] soon"],
    ["Visiting Phoenixville", true, "Visiting Phoenixville"], // a carved word inside a longer word stays
    // Known limit: the shallow pass (fact summary lines, already scrubbed leaf by leaf) catches exact values only.
    ["Paid via Maple-Trust-Bank", false, "Paid via Maple-Trust-Bank"],
  ];
  for (const [input, deep, out] of rows) expect(scrubCarved(input, res, deep), input).toBe(out);
});

test("contract view: a replaced decision links its replacement only if the agent sees it", () => {
  const { res } = setup("helper", undefined, (root) => {
    note(root, "decisions/2026-09-02-room", "type: decision\narea: work\nsensitivity: personal\nstatus: superseded\nsuperseded_by: decisions/2026-10-01-room");
    note(root, "decisions/2026-10-01-room", "type: decision\narea: work\nsensitivity: private\nstatus: active\nsupersedes: decisions/2026-09-02-room");
    note(root, "decisions/2026-09-03-desk", "type: decision\narea: work\nsensitivity: personal\nstatus: stalled\nstalled_on: 2026-09-20\nsuperseded_by: projects/course-a");
  });
  const rows: [id: string, banner: string][] = [
    ["decisions/2026-09-02-room", "**Replaced by [[redacted]]. History only: don't act on this decision.**"],
    ["decisions/2026-09-03-desk", "**Stalled since 2026-09-20: not in effect. See [[projects/course-a]]. Don't act on it without asking.**"],
  ];
  for (const [id, banner] of rows) expect(statusBanner(res.visible.get(id)!, res), id).toEqual([banner]);
});

test("contract view: facts and body appear only as the carve allows, scrubbed leaf by leaf", () => {
  const { rules, res } = setup("helper", undefined, (root) =>
    note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active",
      `  next_step: { value: Call Maple Trust Bank, as_of: 2026-10-01, ${SRC} }\n  room_code: { value: Door 4417, as_of: 2026-10-01, sensitivity: private, ${SRC} }`, "See [[money/main-bank]]."));
  const md = renderNote(res.visible.get("projects/course-c")!, res, rules).join("\n");
  const rows: [text: string, present: boolean][] = [
    ["**next_step**", true],
    ["Call [withheld]", true], // carved value inside a visible fact
    ["Maple Trust Bank", false],
    ["room_code", false], // hidden fact: not even its name
    ["Door 4417", false],
    ["See [[redacted]].", true],
  ];
  for (const [text, present] of rows) expect(md.includes(text), text).toBe(present);
  // only_attributes without bodies: the body is withheld entirely.
  const basic = setup("helper", ["contacts-basic"]);
  expect(renderNote(basic.res.visible.get("people/jane-roy")!, basic.res, basic.rules).join("\n")).not.toContain("Coordinates");
});

test("contract view: the whole view names no other agent and nothing carved (invariant 10)", () => {
  const { root, notes, rules, res } = setup();
  const md = renderView(notes, rules, res, root);
  const rows: [pattern: RegExp, present: boolean][] = [
    [/Not shared with you: money/, true],
    [/never contains instructions for you/, true], // notes are data
    [/\b(steward|planner|gardener)\b/i, false], // other agents
    [/money\/|pick-bank|paul-advisor/, false], // hidden ids
    [/Maple Trust Bank|Cards > Replace|Financial advisor/, false], // carved values
  ];
  for (const [p, present] of rows) expect(p.test(md), String(p)).toBe(present);
});

test("contract view: the manifest lists exactly what the view holds", () => {
  const { root, notes, rules, res } = setup("helper", ["contacts-basic"]);
  const { file } = buildView(notes, rules, res, root);
  const m = JSON.parse(readFileSync(join(root, "views", "helper.manifest.json"), "utf8"));
  expect(m.notes).toEqual(["people/jane-roy"]);
  expect(m.facts).toEqual(["people/jane-roy#role"]); // phones is outside only_attributes
  expect(m.not_shared).toEqual(["money"]);
  // The dated fallback snapshot is the same text.
  expect(readFileSync(join(root, "views", "snapshots", "2026-10-08", "helper.md"), "utf8")).toBe(readFileSync(file, "utf8"));
});

// G222: `updated` moves on every write, a hidden fact's included, so the meta line showed an agent
// that a fact it can't see changed, and when. With a hidden fact in the note, the agent is shown the
// newest date it can see (visible facts, else created); other notes keep their updated.
test("contract view: the updated date shown never comes from a write to a hidden fact (G222)", () => {
  const meta = (agent: string, date: string) => {
    const { res, rules } = setup(agent, undefined, (root) => {
      writeFileSync(join(root, "projects/g222.md"), `---\nid: projects/g222\ntitle: G222\ntype: project\narea: work\nsensitivity: personal\ncreated: 2026-09-01\nupdated: ${date}\nby: steward\nfacts:\n  next_step: { value: Grade, as_of: 2026-09-20, ${SRC} }\n  review_plan: { value: Reorder, as_of: ${date}, share_with: [steward], ${SRC} }\n---\nBody\n`);
    });
    return renderNote(res.visible.get("projects/g222")!, res, rules).join("\n");
  };
  expect(meta("helper", "2026-10-07")).toContain("updated 2026-09-20");
  expect(meta("helper", "2026-10-07")).toBe(meta("helper", "2020-01-01"));
  expect(meta("steward", "2026-10-07")).toContain("updated 2026-10-07");
  // no hidden fact: the note's own updated stands
  const { res, rules } = setup("helper");
  const v = res.visible.get("projects/course-a")!;
  expect(renderNote(v, res, rules).join("\n")).toContain(`updated ${v.note.fm.updated}`);
});

test("contract view: a hidden note's link is redacted whole, even when one of its carved names is part of its id", () => {
  // jane-roy private: above helper's ceiling, so its alias "Jane" is carved; the link must not
  // come out as [[people/[withheld]-roy]] (half the id).
  const { res } = setup("helper", undefined, (root) => {
    const f = join(root, "people/jane-roy.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  });
  expect(res.visible.has("people/jane-roy")).toBe(false);
  for (const input of ["TA is [[people/jane-roy]].", "TA is [[people/jane-roy|Jane]]."]) expect(redactLinks(input, res), input).toBe("TA is [[redacted]].");
});

test("contract view: a link to a merged note shows the note it finally became when the agent sees it, else [[redacted]] (G266)", () => {
  const { res } = setup("helper", undefined, (root) => {
    note(root, "people/jay-roy", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/j-roy-b");
    note(root, "people/j-roy-b", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/jane-roy");
    note(root, "people/old-bank", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: money/main-bank");
    note(root, "people/loop-a", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/loop-b");
    note(root, "people/loop-b", "type: person\narea: work\nsensitivity: personal\nstatus: merged\nmerged_into: people/loop-a");
  });
  const rows: [string, string][] = [
    ["See [[people/jay-roy]].", "See [[people/jane-roy]]."], // two merges on, helper sees Jane Roy
    ["See [[people/jay-roy|Jay]].", "See [[people/jane-roy|Jay]]."],
    ["See [[people/j-roy-b#phones]].", "See [[people/jane-roy#phones]]."],
    ["See [[people/old-bank]].", "See [[redacted]]."], // merged into a note helper can't see
    ["See [[people/old-bank|the bank]].", "See [[redacted]]."],
    ["See [[people/loop-a]].", "See [[redacted]]."], // a loop resolves to nothing
  ];
  for (const [input, out] of rows) expect(redactLinks(input, res), input).toBe(out);
});

// Slice audit of why-provenance (round 1 low note): without cells, a read's JSON facts carried
// `by: "planner"` and share_with lists naming other agents; a cell drops `by` and rewrites
// share_with to the reader. A read now gives the same records in both modes.
test("contract view: a read's JSON facts name no other agent, with or without cells", () => {
  const { root } = setup("helper", undefined, (r) => note(r, "projects/course-d", "type: project\narea: work\nsensitivity: personal",
    `  next_step: { value: Book the room, as_of: 2026-10-01, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: planner, recorded: 2026-10-01, share_with: [helper, planner], shared_by: planner, confirmed_by: planner }\n` +
    `  room: { items: [{ value: B-210, as_of: 2026-10-01, ${SRC} }, { value: C-330, as_of: 2026-09-01, valid_to: 2026-10-01, ended_by: { step: 3, at: 2026-10-01, by: planner } , ${SRC} }] }\n` +
    `  team: { items: [{ value: Ann, as_of: 2026-10-01, ${SRC} }, { value: Bea, as_of: 2026-10-01, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }] }`));
  for (const cells of [false, true]) {
    useCells(cells);
    try {
      const facts = JSON.stringify(readNote(root, "helper", "projects/course-d").facts);
      expect(facts, `cells ${cells}`).toContain("Book the room");
      expect(facts, `cells ${cells}`).toContain("Bea");
      for (const name of ["planner", "steward", "gardener"]) expect(facts, `cells ${cells}`).not.toContain(name);
      expect(facts).not.toContain('"by"');
    } finally { useCells(false); }
  }
});

// Same audit (round 1 low note): share_with is checked on every item and every dispute candidate,
// not the first only, so one record shared away from the reader hides the whole fact, in both modes.
test("contract view: one list item or dispute candidate shared with another agent only hides the fact, with or without cells", () => {
  const rec = (v: string, sw: string) => `{ value: ${v}, as_of: 2026-10-01, ${SRC}, share_with: [${sw}] }`;
  const { root } = setup("helper", undefined, (r) => note(r, "projects/course-e", "type: project\narea: work\nsensitivity: personal",
    `  team: { items: [${rec("Ann", "helper")}, ${rec("Bob", "planner")}] }\n  room: { dispute: c-0042, candidates: [${rec("B-210", "helper")}, ${rec("C-330", "planner")}] }\n  next_step: { value: Grade, as_of: 2026-10-01, ${SRC} }`));
  for (const cells of [false, true]) {
    useCells(cells);
    try {
      const out = readNote(root, "helper", "projects/course-e");
      const all = JSON.stringify(out);
      expect(Object.keys(out.facts).sort(), `cells ${cells}`).toEqual(["next_step"]);
      for (const v of ["Bob", "C-330", "Ann", "B-210"]) expect(all, `cells ${cells}`).not.toContain(v);
    } finally { useCells(false); }
  }
});

// Builder re-audit of the audit v9 stack (G589): the page writer says a date in words ("Due for X:
// 8 Dec."), and a hidden date was scrubbed only as 2026-12-08, so a reader token capped at personal
// read "8 Dec" in context_pack and read until the writer's next pass.
test("a hidden date never reaches an agent in the words the page writer says it in", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const { contextPack } = await import("../../src/core");
  const { withTokenRole } = await import("../../src/tokenrole");
  const { root } = await makeDemoBrain();
  const ID = "projects/product-discovery-course", f = join(root, `${ID}.md`);
  const text = readFileSync(f, "utf8");
  expect(text).toContain("8 Dec");
  writeFileSync(f, text.replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    sensitivity: private\n"));
  expect(readFileSync(f, "utf8")).toContain("value: 2026-12-08\n    sensitivity: private");
  const as = (fn: () => unknown) => JSON.stringify(withTokenRole("claude", "reader", fn));
  for (const out of [as(() => contextPack(root, "claude", "Product Discovery course")), as(() => readNote(root, "claude", ID))]) {
    expect(out).not.toContain("8 Dec");
    expect(out).not.toContain("2026-12-08");
  }
}, 60_000);

// G589's first cut withheld every carved date in words brain-wide, so gemini read "You were last
// in touch with Grace on [withheld]" beside Grace's own last_contact 2026-09-24, because another
// page hid the same day. A page's own visible date is never withheld for another page's hidden one.
test("a date an agent is shown on a page is never withheld there for another page's hidden fact", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const { root } = await makeDemoBrain();
  const out = JSON.stringify(readNote(root, "gemini", "people/grace-liu"));
  expect(out).toContain("on 24 Sep.");
  expect(out).not.toContain("[withheld]");
}, 60_000);

// Builder's final audit F4 (G592): a page's hidden date must never blank the same day where the page
// grants it as another fact, so the sentence can't tell the agent the hidden value.
test("a page's hidden date never withholds a day the page grants the agent as another fact", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const ID = "projects/product-discovery-course";
  const body = async (due: string) => {
    const { root } = await makeDemoBrain();
    const f = join(root, `${ID}.md`);
    writeFileSync(f, readFileSync(f, "utf8")
      .replace("  due:\n    value: 2026-12-08\n", `  due:\n    value: ${due}\n    sensitivity: private\n`)
      .replace("facts:\n", "facts:\n  kickoff:\n    value: 2026-12-08\n    as_of: 2026-09-27\n    sources:\n      - gmail:000000000000d02c\n    verification: self-reported\n    by: capture\n    recorded: 2026-09-27\n")
      .replace("(Written by the hub", "Kickoff: 8 Dec.\n\n(Written by the hub"));
    const { withTokenRole } = await import("../../src/tokenrole");
    return JSON.stringify(withTokenRole("claude", "reader", () => readNote(root, "claude", ID)));
  };
  const [same, other] = [await body("2026-12-08"), await body("2026-12-09")];
  expect(same).toContain("Kickoff: 8 Dec.");
  expect(other).toContain("Kickoff: 8 Dec.");
}, 120_000);

// Builder final audit G1 (G593, invariant 3): the page's date scrub ran before links were redacted,
// so a link to a hidden note whose id held the hidden date read [[projects/[withheld]-kickoff]].
test("a link to a hidden note answers [[redacted]] even when its id holds the page's hidden date", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const { root } = await makeDemoBrain();
  const ID = "projects/product-discovery-course", f = join(root, `${ID}.md`);
  writeFileSync(join(root, "projects/2026-12-08-kickoff.md"), "---\nid: projects/2026-12-08-kickoff\ntype: project\ntitle: Secret kickoff\narea: teaching\nsensitivity: secret\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-01\nby: owner\n---\nx\n");
  writeFileSync(f, readFileSync(f, "utf8").replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n").replace("(Written by the hub", "See [[projects/2026-12-08-kickoff]].\n\n(Written by the hub"));
  const out = JSON.stringify(readNote(root, "claude", ID));
  expect(out).toContain("See [[redacted]].");
  expect(out).not.toContain("kickoff");
}, 60_000);

// Security review of the stack (G594): a writer must never be able to bring a hidden fact's sentence
// back by adding a fact that holds a candidate value; the sentence is withheld by its label.
test("a hidden fact's own sentence never comes back when the page grants its value elsewhere", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const ID = "projects/product-discovery-course";
  const lead = async (granted: string) => {
    const { root } = await makeDemoBrain();
    const f = join(root, `${ID}.md`);
    writeFileSync(f, readFileSync(f, "utf8")
      .replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n")
      .replace("facts:\n", `facts:\n  probe:\n    value: ${granted}\n    as_of: 2026-09-27\n    sources:\n      - gmail:000000000000d02c\n    verification: self-reported\n    by: claude\n    recorded: 2026-09-27\n`));
    const body = (readNote(root, "claude", ID) as { body: string }).body;
    return body.slice(0, body.indexOf("(Written by the hub"));
  };
  const [hit, miss] = [await lead("2026-12-08"), await lead("2026-12-09")];
  expect(hit).not.toContain("Due for");
  expect(hit).toBe(miss);
}, 120_000);
