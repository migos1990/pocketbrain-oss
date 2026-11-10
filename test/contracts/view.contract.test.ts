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
import { redactLinks, scrubCarved, scrubPage, pageSummary, statusBanner, renderNote, renderView, buildView } from "../../src/view";
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

test("contract view: on a page that links a note out of view, that note's names are withheld from the page's text and summary (G754, G755)", () => {
  // money/main-bank ("Main bank") is out of helper's view by type.
  const { res } = setup("helper", undefined, (root) => {
    note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active\nsummary: Course C is paid through the Main bank.",
      `  payer: { value: "[[money/main-bank|the house account]]", as_of: 2026-10-01, ${SRC} }`, "The payer of Course C is Main bank.\n\nMain-Bank, in another spelling.\n\nAsk the house account.");
    note(root, "projects/course-d", "type: project\narea: work\nsensitivity: personal\nstatus: active", "", "Main bank is a common pair of words on a page that links nothing hidden.");
  });
  const c = res.visible.get("projects/course-c")!, d = res.visible.get("projects/course-d")!;
  expect(scrubPage(c.note.body, c, res)).toBe("The payer of Course C is [withheld].\n\n[withheld]\n\nAsk [withheld].\n");
  expect(pageSummary(c, res)).toBe("Course C is paid through the [withheld].");
  // Only on the page that links it: elsewhere a title outside a view is no carved value.
  expect(scrubPage(d.note.body, d, res)).toBe(d.note.body);
  // A reader who sees the note keeps its name.
  const all = setup("steward", undefined, (root) => note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active", `  payer: { value: "[[money/main-bank]]", as_of: 2026-10-01, ${SRC} }`, "Paid by Main bank."));
  expect(scrubPage("Paid by Main bank.", all.res.visible.get("projects/course-c")!, all.res)).toBe("Paid by Main bank.");
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

// G596: the writer's labels are per fact (pf-<attr>), so withholding is exact: hiding one fact never
// takes another fact's sentence with it, even when both cite the same mail.
test("a hidden fact's label takes only its own sentence, never one about a shown fact", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const ID = "projects/product-discovery-course";
  const { root } = await makeDemoBrain();
  const f = join(root, `${ID}.md`);
  writeFileSync(f, readFileSync(f, "utf8").replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n"));
  const all = (readNote(root, "chatgpt", ID) as { body: string }).body;
  const cut = (readNote(root, "claude", ID) as { body: string }).body;
  const sentences = [...all.matchAll(/[^\n.]*?\.(?:\[\^pf-[a-z0-9-]+\])+/g)].map((m) => m[0].trim());
  const shown = sentences.filter((s) => !s.includes("[^pf-due]"));
  expect(sentences.some((s) => s.includes("[^pf-due]"))).toBe(true);
  expect(shown.length).toBeGreaterThan(1);
  for (const s of shown) expect(cut).toContain(s);
  expect(cut).not.toContain("[^pf-due]");
}, 60_000);

// Security review of G596's replay (65320f99): a page whose lead the writer rewrote with pf- labels
// can still hold a section citing an older label, [^p-<attr>] or a label whose reference names the
// hidden fact's source. Exact pf- labels never turned the older matching off for the whole page.
test("a page with a pf- lead still loses a section sentence citing the hidden fact's older label", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const ID = "projects/product-discovery-course";
  const { root } = await makeDemoBrain();
  const f = join(root, `${ID}.md`);
  const src = readFileSync(f, "utf8");
  expect(src).toContain("[^pf-due]");
  writeFileSync(f, src.replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n")
    .trimEnd() + "\n\n## Notes\n\nHand-ins close that week.[^p-due] The room is booked.\n");
  const body = (readNote(root, "claude", ID) as { body: string }).body;
  expect(body).not.toContain("Hand-ins close that week.");
  expect(body).not.toContain("[^p-due]");
  expect(body).toContain("The room is booked.");
  expect(body).not.toContain("[^pf-due]");
  expect(body).toContain("week 6 of 13");
}, 60_000);

// Slice audit of G596's replay (tree 1585ee91), F2: a page whose opening still has the shared p-
// labels lost no sentence once any [^pf- label sat elsewhere on it (a section a person or the
// Gardener wrote), so the agent read the hidden date in the old opening.
test("an old p- opening still loses the hidden fact's sentence when a section carries a pf- label", async () => {
  const { makeDemoBrain } = await import("../fixture");
  const ID = "projects/product-discovery-course";
  const { root } = await makeDemoBrain();
  const f = join(root, `${ID}.md`);
  const raw = readFileSync(f, "utf8");
  const head = raw.slice(0, raw.indexOf("\n---\n", 4) + 5).replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n");
  const REF = "Email, 2026-09-27 (gmail:000000000000d02c)";
  writeFileSync(f, head + `Product Discovery course is week 6 of 13.[^p-status] Due for Product Discovery course: 8 Dec.[^p-status]\n\n(Written by the hub from this page's facts.)\n\n## Notes\nRoom booked.[^pf-room]\n\n[^pf-room]: Email, 2026-10-01 (gmail:000000000000aaaa)\n[^p-status]: ${REF}\n`);
  const body = (readNote(root, "claude", ID) as { body: string }).body;
  expect(body).not.toContain("8 Dec");
  expect(body).toContain("Room booked.");
}, 60_000);

// PR 30 review (Low): a writer's cross-page label (p-at-, p-in-, p-see-) carries only the other
// page's short name. A visible page of another kind with that short name never keeps the sentence
// about a page out of the reader's view: the page the sentence links decides.
test("contract view: a cross-page sentence about a hidden page goes, whatever page shares its short name", () => {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  const fm = (id: string, type: string, title: string, sens = "personal") => `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: ${sens}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
  writeFileSync(join(root, "people", "ana-diaz.md"), fm("people/ana-diaz", "person", "Ana Diaz", "private") + `facts:\n  org: { value: "[[orgs/north-college]]", as_of: 2026-10-05, sources: ["gmail:f0000000000000a2"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n---\n`);
  writeFileSync(join(root, "projects", "ana-diaz.md"), fm("projects/ana-diaz", "project", "Ana Diaz Fund") + "---\n");
  writeFileSync(join(root, "orgs", "north-college.md"), fm("orgs/north-college", "org", "North College") + "---\n[[people/ana-diaz|Ana Diaz]] works at North College.[^p-at-ana-diaz]\n\n[^p-at-ana-diaz]: Email, 2026-10-05 (gmail:f0000000000000a2)\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "planner: fixture"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "planner", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "planner", GIT_COMMITTER_EMAIL: "p@x" } });
  const body = (readNote(root, "helper", "orgs/north-college") as { body: string }).body;
  expect(body).not.toContain("works at North College");
  expect(body).not.toContain("gmail:f0000000000000a2");
});

test("contract view: a short form of a hidden linked page's name and a label spelling it are withheld; a carved value in a label still withholds its line (slice audit of G754)", () => {
  const { res } = setup("helper", undefined, (root) => {
    note(root, "money/zorblax-fund", "type: money\narea: work\nsensitivity: personal\nstatus: active");
    note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active",
      `  payer: { value: "[[money/zorblax-fund]]", as_of: 2026-10-01, ${SRC} }`,
      "Paid by Zorblax in May.\n\nSigned.[^p-rel-zorblax]\n\nSee Course A.[^p-see-course-a]\n\nBanked.[^maple-trust-bank]");
  });
  const c = res.visible.get("projects/course-c")!;
  expect(scrubPage(c.note.body, c, res)).toBe("Paid by [withheld] in May.\n\n[withheld]\n\nSee Course A.[^p-see-course-a]\n\n[withheld]\n");
});

// Security review of G754's set-aside: a reader's own value is kept as written only where the hub
// printed it as whole words; never letters inside another writer's word, never for an ended record.
test("contract view: a reader's own short or ended value never unmasks another writer's words in the hub's sentence", () => {
  const r = (by: string, value: string, more = "") => `{ value: "${value}", as_of: 2026-10-01, sources: ["gmail:f0000000000000a1"], verification: verified-by-source, by: ${by}, recorded: 2026-10-01${more} }`;
  const { res } = setup("helper", undefined, (root) => {
    note(root, "money/zorblax-fund", "type: money\narea: work\nsensitivity: personal\nstatus: active");
    note(root, "projects/course-c", "type: project\narea: work\nsensitivity: personal\nstatus: active",
      `  payer: { value: "[[money/zorblax-fund]]", as_of: 2026-10-01, ${SRC} }\n  events:\n    items:\n      - ${r("planner", "money/zorblax-fund offsite in May")}\n      - ${r("helper", "or", ", valid_to: 2026-10-02")}\n      - ${r("helper", "la")}`,
      "Course C's events are money/zorblax-fund offsite in May and la.[^pf-events]\n\n(Written by the hub from this page's facts.)\n\n[^pf-events]: Email, 2026-10-01 (gmail:f0000000000000a1)");
  });
  const c = res.visible.get("projects/course-c")!;
  expect(scrubPage(c.note.body, c, res).split("\n")[0]).toBe("Course C's events are [withheld] offsite in May and la.[^pf-events]");
});

// Audit v13 (G761): a model's opening reaches a reader whole or not at all. When the read drops or
// changes a sentence it rests on, the opening goes with it; it is never served with a name withheld.
test("contract view: a model's opening goes whole when a sentence it rests on does", () => {
  const OP = "Pia Roe leads Course D with Quin Vale.";
  const body = `${OP}[^p-at-pia-roe][^pf-status]\n\nCourse D is active.[^pf-status] [[people/pia-roe|Pia Roe]] and [[people/quin-vale|Quin Vale]] lead Course D.[^p-at-pia-roe][^p-at-quin-vale]\n\n[^pf-status]: Email, 2026-10-01 (gmail:f000000000000009)\n[^p-at-pia-roe]: Email, 2026-10-01 (gmail:f000000000000009)\n[^p-at-quin-vale]: Email, 2026-10-01 (gmail:f000000000000009)`;
  const build = (quin: string) => setup("helper", undefined, (root) => {
    note(root, "people/pia-roe", "type: person\narea: work\nsensitivity: personal\nstatus: active");
    note(root, "people/quin-vale", `type: person\narea: work\nsensitivity: ${quin}\nstatus: active`);
    note(root, "projects/course-d", `type: project\narea: work\nsensitivity: personal\nstatus: active\nopening: { text: "${OP}", labels: [p-at-pia-roe, pf-status], by: gardener, on: 2026-10-07 }`,
      `  status: { value: active, as_of: 2026-10-01, ${SRC} }`, body);
  }).res;
  const shown = build("personal"), hid = build("private");
  const a = shown.visible.get("projects/course-d")!, b = hid.visible.get("projects/course-d")!;
  expect(scrubPage(a.note.body, a, shown)).toContain(OP);
  const got = scrubPage(b.note.body, b, hid);
  expect(got).not.toContain("leads Course D");
  expect(got).not.toMatch(/Quin|Vale|\[withheld\]/);
  expect(got).toContain("Course D is active.");
});

// Code review of PR 149: splitting a page around the hub's block never adds a line of its own.
test("contract view: a page whose hub block is empty reads back line for line", () => {
  const MADE = "(Written by the hub from this page's facts.)";
  for (const body of [`${MADE}\n\nA note.`, `Lead line.\n\n## Facts\n${MADE}\n\nA note.`]) {
    const { res } = setup("helper", undefined, (root) => note(root, "projects/course-e", "type: project\narea: work\nsensitivity: personal\nstatus: active", "", body));
    const e = res.visible.get("projects/course-e")!;
    expect(scrubPage(e.note.body, e, res)).toBe(e.note.body);
  }
});
