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
