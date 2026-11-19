// SPDX-License-Identifier: AGPL-3.0-only
// A restart never hands back what the hub set aside on purpose (G1006, G1007). A capture the hub
// accepted and saved, whose fact a set-aside then took with its page (machine mail, a page named
// only by a first name), looked at the next start like an accept with nothing saved (G431): the page
// its name fits was gone, so it went back to the owner as something to look at, once per fact. The
// page as the set-aside removed it held the value, so it stays decided. One the older code already
// handed back is closed again at the next start, by the same rule; one whose page was never made
// still goes back, and Undo of the set-aside brings the page and its fact back as they were.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { reopenLostAccepts, closeSetAsideAgain } from "../src/write";
import { setAsideMachineMail } from "../src/receipt-pages";
import { recordMachineMail } from "../src/louis";
import { loadBrain } from "../src/brain";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { ownerAsks } from "../src/waiting";

const TOLL = "gmail:f0000000000000c1", PARCEL = "gmail:f0000000000000c2", GYM = "gmail:f0000000000000c3", PERSON = "gmail:f0000000000000d1";
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "owner@pocketbrain.local", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "owner@pocketbrain.local" } });
const decided = (root: string, name: string, request: Record<string, unknown>) =>
  writeFileSync(join(root, "inbox", "decided", name), YAML.stringify({ proposed: "2026-10-25", by: "auto-decide", reason: "capture", checks: ["capture"], capture: "inbox/captures/x.md", request, decided: "2026-10-25", decision: "accept" }));
const byTitle = (title: string, attribute: string, value: string, source: string) => ({ kind: "fact", agent: "steward", type: "org", title, area: "work", attribute, value, as_of: "2026-10-25", sources: [source] });
const page = (root: string, id: string, title: string, facts: string) =>
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: org\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-25\nupdated: 2026-10-25\nby: steward\nfacts:\n${facts}---\n`);
const fact = (attr: string, value: string, source: string) => `  ${attr}: { value: "${value}", as_of: 2026-10-25, sources: ["${source}"], verification: verified-by-source, by: steward, recorded: 2026-10-25 }\n`;
const inbox = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).sort();

// Three captures the hub accepted and saved: two on pages that hold nothing but machine mail (one
// named by a title that only an alias of the page fits), one on a page a person's mail keeps.
function rig() {
  const root = makeBrain();
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  mkdirSync(join(root, "orgs"), { recursive: true });
  page(root, "orgs/span-toll-road", "Span Toll Road", fact("status", "crossing paid on the north span", TOLL));
  page(root, "orgs/crate-parcel-depot", "Crate Parcel Depot\naliases: [Crate Depot]", fact("website", "crate-depot.example", PARCEL));
  page(root, "orgs/lark-climbing-hall", "Lark Climbing Hall", fact("status", "pass renewed for the winter", GYM) + fact("website", "lark-hall.example", PERSON));
  decided(root, "2026-10-25-capture-toll0001.yaml", byTitle("Span Toll Road", "status", "crossing paid on the north span", TOLL));
  decided(root, "2026-10-25-capture-crate001.yaml", byTitle("Crate Depot", "website", "crate-depot.example", PARCEL));
  decided(root, "2026-10-25-capture-lark0001.yaml", byTitle("Lark Climbing Hall", "status", "pass renewed for the winter", GYM));
  recordMachineMail(root, [TOLL, PARCEL, GYM]);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  return root;
}
const ids = (root: string) => loadBrain(root).map((n) => n.fm.id).filter((id) => /span-toll|crate-parcel|lark-climbing/.test(id)).sort();

test("a capture whose fact machine mail's set-aside took, page and all, is not handed back at the next start", () => {
  const root = rig();
  expect(reopenLostAccepts(root)).toEqual([]); // saved: nothing is lost
  const before = ownerAsks(root).total;
  expect(setAsideMachineMail(root, true)).toMatchObject({ facts: 3, removed: ["orgs/crate-parcel-depot", "orgs/span-toll-road"].sort() });
  expect(ids(root)).toEqual(["orgs/lark-climbing-hall"]);
  // the hub restarts
  expect(closeSetAsideAgain(root)).toEqual([]);
  expect(reopenLostAccepts(root)).toEqual([]);
  expect(inbox(root)).toEqual([]);
  expect(readdirSync(join(root, "inbox", "decided")).sort()).toEqual(["2026-10-25-capture-crate001.yaml", "2026-10-25-capture-lark0001.yaml", "2026-10-25-capture-toll0001.yaml"]);
  expect(ownerAsks(root).total).toBe(before);
  expect(sh(root, "git", "status", "--porcelain").stdout.toString().trim()).toBe("");
});

test("one an older hub handed back for this is closed again at the next start, once, and nothing else is", () => {
  const root = rig();
  const before = ownerAsks(root).total;
  setAsideMachineMail(root, true);
  // What the older code left: the two captures back in the inbox, stamped, their decided copies gone.
  for (const f of ["2026-10-25-capture-toll0001.yaml", "2026-10-25-capture-crate001.yaml"]) {
    const { decided: _d, decision: _x, by: _b, ...open } = YAML.parse(readFileSync(join(root, "inbox", "decided", f), "utf8"));
    writeFileSync(join(root, "inbox", f), YAML.stringify({ ...open, by: "steward", reopened: "2026-11-19" }));
    sh(root, "git", "rm", "-q", `inbox/decided/${f}`);
  }
  // Two that went back for the reason the step exists: a page never made, and a value never saved.
  writeFileSync(join(root, "inbox", "2026-10-25-capture-never001.yaml"), YAML.stringify({ proposed: "2026-10-25", by: "steward", reason: "capture", capture: "inbox/captures/y.md", request: byTitle("Wren Paper Mill", "status", "open on weekdays", PERSON), reopened: "2026-11-19" }));
  writeFileSync(join(root, "inbox", "2026-10-25-capture-other001.yaml"), YAML.stringify({ proposed: "2026-10-25", by: "steward", reason: "capture", capture: "inbox/captures/z.md", request: byTitle("Span Toll Road", "status", "the south span closes in March", PERSON), reopened: "2026-11-19" }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "hub: 4 accepted capture(s) with nothing saved back in the inbox");
  expect(ownerAsks(root).total).toBe(before + 4);

  expect(closeSetAsideAgain(root).sort()).toEqual(["2026-10-25-capture-crate001.yaml", "2026-10-25-capture-toll0001.yaml"]);
  expect(inbox(root)).toEqual(["2026-10-25-capture-never001.yaml", "2026-10-25-capture-other001.yaml"]);
  expect(ownerAsks(root).total).toBe(before + 2);
  const back = YAML.parse(readFileSync(join(root, "inbox", "decided", "2026-10-25-capture-toll0001.yaml"), "utf8"));
  expect(back).toMatchObject({ decision: "accept", by: "auto-decide", reopened: "2026-11-19", capture: "inbox/captures/x.md" });
  expect(back.request.value).toBe("crossing paid on the north span");
  const log = sh(root, "git", "log", "-1", "--format=%an%n%B").stdout.toString();
  expect(log).toMatch(/^hub\n/);
  expect(log).toMatch(/G1007/);
  expect(sh(root, "git", "status", "--porcelain").stdout.toString().trim()).toBe("");
  // again, and at every later start: nothing moves
  expect(closeSetAsideAgain(root)).toEqual([]);
  expect(reopenLostAccepts(root)).toEqual([]);
  expect(inbox(root)).toHaveLength(2);
});

test("Undo of the set-aside still brings the page and its fact back, and the capture stays answered", () => {
  const root = rig();
  setAsideMachineMail(root, true);
  expect(reopenLostAccepts(root)).toEqual([]);
  const row = readDiary(root).find((r) => r.fact_key === "orgs/span-toll-road#status" && r.kind === "retracted")!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  const note = loadBrain(root).find((n) => n.fm.id === "orgs/span-toll-road")!;
  expect((note.fm.facts!.status as { value: string }).value).toBe("crossing paid on the north span");
  expect(reopenLostAccepts(root)).toEqual([]);
  expect(closeSetAsideAgain(root)).toEqual([]);
  expect(inbox(root)).toEqual([]);
  expect(existsSync(join(root, "inbox", "decided", "2026-10-25-capture-toll0001.yaml"))).toBe(true);
});

test("a page that never was is still handed back: only a page the hub set aside counts", () => {
  const root = rig();
  setAsideMachineMail(root, true);
  decided(root, "2026-10-25-capture-never001.yaml", byTitle("Wren Paper Mill", "status", "open on weekdays", PERSON));
  // The set-aside page held another value: this one was never saved on it.
  decided(root, "2026-10-25-capture-other001.yaml", byTitle("Span Toll Road", "status", "the south span closes in March", PERSON));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  expect(reopenLostAccepts(root).sort()).toEqual(["2026-10-25-capture-never001.yaml", "2026-10-25-capture-other001.yaml"]);
});

// Slice audit of this branch, N1: the page as git last removed it is only read when the hub removed
// it, and a name the owner forgot is never answered as accepted.
test("a page someone else removed since, or a name the owner forgot, is never answered again", () => {
  const handedBack = (root: string) => {
    const f = "2026-10-25-capture-toll0001.yaml";
    const { decided: _d, decision: _x, by: _b, ...open } = YAML.parse(readFileSync(join(root, "inbox", "decided", f), "utf8"));
    writeFileSync(join(root, "inbox", f), YAML.stringify({ ...open, by: "steward", reopened: "2026-11-19" }));
    sh(root, "git", "rm", "-q", `inbox/decided/${f}`);
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "hub: handed back");
  };
  // The owner's Forget of that name, after the set-aside.
  let root = rig();
  setAsideMachineMail(root, true);
  handedBack(root);
  sh(root, "git", "commit", "-q", "--allow-empty", "-m", "owner: forget\n\nForgot-Person: orgs/span-toll-road");
  expect(closeSetAsideAgain(root)).toEqual([]);
  expect(inbox(root)).toEqual(["2026-10-25-capture-toll0001.yaml"]);
  // The page made again with the same value, then removed by hand: the last removal is not the hub's.
  root = rig();
  setAsideMachineMail(root, true);
  handedBack(root);
  page(root, "orgs/span-toll-road", "Span Toll Road", fact("status", "crossing paid on the north span", PERSON));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: made again");
  sh(root, "git", "rm", "-q", "orgs/span-toll-road.md"); sh(root, "git", "commit", "-qm", "owner: removed by hand");
  expect(closeSetAsideAgain(root)).toEqual([]);
  expect(inbox(root)).toEqual(["2026-10-25-capture-toll0001.yaml"]);
});
