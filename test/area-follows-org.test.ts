// SPDX-License-Identifier: AGPL-3.0-only
// G664, the Oliver case: a person's page filed in an area by an org link that turned out wrong had
// no way to move. When the owner's own word says where someone works, the page moves to that org's
// area with it, shown on the home with Undo; nothing else moves a page. Each of the four owner
// paths (the box, the page's box, the editor's set-fact, Settle with a typed value) moves it, so a
// path that forgets to call followArea fails here.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { ownerSay } from "../src/owner-say";
import { setFact } from "../src/dashboard/edit";
import { inboxConflicts, settleInbox } from "../src/settle-inbox";
import { ownerConflicts, ownerDecide, readNote } from "../src/core";
import { write } from "../src/write";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { homeView } from "../src/dashboard/home";
import { gitRun } from "../src/git";

const MAYA = "people/maya-chen";
const areaOf = (root: string, id = MAYA) => String(loadBrain(root).find((n) => n.fm.id === id)?.fm.area);
const moved = (root: string) => readDiary(root).filter((r) => r.kind === "moved");

async function brain() {
  process.env.PB_NOW = DEMO_NOW;
  const { root } = await makeDemoBrain();
  expect(areaOf(root)).toBe("work"); // Harbourline Software's area
  return root;
}

test("the box: 'Maya Chen works at Atelier Boréal' moves her page to that org's area, with a home line whose Undo moves it back", async () => {
  try {
    const root = await brain();
    ownerSay(root, "Maya Chen works at Atelier Boréal");
    expect(areaOf(root)).toBe("personal");
    const [row] = moved(root);
    expect(row).toMatchObject({ fact_key: `${MAYA}#`, from: "work", to: "personal" });
    // The move names the org commit it followed.
    expect(gitRun(root, ["log", "-1", "--grep=^Kind: area-follows$", "--format=%B"]).out).toContain(`Area-Follows: ${row!.follows}`);
    const view = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true, fresh: true });
    expect(JSON.stringify(view)).toContain("page moved from Work to Personal, with the workplace you named");
    expect(undoFact(root, row!.undo_token).outcome).toBe("undone");
    expect(areaOf(root)).toBe("work");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("the page's box moves the page too", async () => {
  try {
    const root = await brain();
    ownerSay(root, "Maya works at Atelier Boréal", { page: MAYA } as never);
    expect(areaOf(root)).toBe("personal");
    expect(moved(root)).toHaveLength(1);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("the editor's set-fact moves the page too", async () => {
  try {
    const root = await brain();
    setFact(root, MAYA, "org", "[[orgs/atelier-boreal]]");
    expect(areaOf(root)).toBe("personal");
    expect(moved(root)).toHaveLength(1);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("Settle: a value the owner types moves the page, a tap on a source's side does not", async () => {
  try {
    const root = await brain();
    // An assistant's different workplace contradicts the page: a conflict for the owner.
    write(root, { agent: "chatgpt", id: MAYA, attribute: "org", value: "[[orgs/fieldnote]]", as_of: "2026-10-08", sources: ["gmail:f00000000000a664"], verification: "verified-by-source" } as never);
    const c = ownerConflicts(root).find((x) => x.page === MAYA && x.attr === "org");
    if (c) {
      ownerDecide(root, c.id, "[[orgs/atelier-boreal]]", `settle-${c.id}`, { typed: true });
    } else {
      const i = inboxConflicts(root).find((x) => x.page === MAYA && x.attr === "org");
      expect(i).toBeDefined();
      settleInbox(root, i!.id, { typed: "[[orgs/atelier-boreal]]" });
    }
    expect(areaOf(root)).toBe("personal");
    expect(moved(root)).toHaveLength(1);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("Settle from the inbox: a typed value moves the page", async () => {
  try {
    const root = await brain();
    // A private fact on the page makes an assistant's differing proposal a conflict in the inbox.
    write(root, { agent: "owner", id: MAYA, attribute: "health_note", value: "x", as_of: "2026-10-07", sources: ["owner:2026-10-07/home"], verification: "confirmed-by-owner", sensitivity: "private" } as never, { owner: true });
    mkdirSync(join(root, "inbox"), { recursive: true });
    writeFileSync(join(root, "inbox", "2026-10-08-g664.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "chatgpt", reason: "a page holding a private fact", request: { agent: "chatgpt", kind: "fact", id: MAYA, attribute: "org", value: "[[orgs/fieldnote]]", as_of: "2026-10-07", sources: ["gmail:f00000000000b664"], verification: "verified-by-source" } }));
    const i = inboxConflicts(root).find((x) => x.page === MAYA && x.attr === "org");
    expect(i).toBeDefined();
    settleInbox(root, i!.id, { typed: "[[orgs/atelier-boreal]]" });
    expect(areaOf(root)).toBe("personal");
    expect(moved(root)).toHaveLength(1);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("an assistant's or a source's workplace never moves a page", async () => {
  try {
    const root = await brain();
    write(root, { agent: "claude", id: MAYA, attribute: "org", value: "[[orgs/atelier-boreal]]", as_of: "2026-10-09", sources: ["gmail:f00000000000c664"], verification: "verified-by-source" } as never);
    expect(areaOf(root)).toBe("work");
    expect(moved(root)).toHaveLength(0);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("a page the owner placed in another area than its org's stays where he put it; no page or the same area moves nothing", async () => {
  try {
    const root = await brain();
    const f = join(root, `${MAYA}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^area: work$/m, "area: teaching"));
    gitRun(root, ["commit", "-qam", "owner: Maya under teaching"]);
    ownerSay(root, "Maya Chen works at Atelier Boréal");
    expect(areaOf(root)).toBe("teaching");
    // Ben Carter's new workplace is an org with no page: nothing moves.
    ownerSay(root, "Ben Carter works at Nowhere Labs Inc");
    expect(areaOf(root, "people/ben-carter")).toBe("work");
    expect(moved(root)).toHaveLength(0);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("Undo of a move refuses once the page moved again, and when the page is gone", async () => {
  try {
    const root = await brain();
    ownerSay(root, "Maya Chen works at Atelier Boréal");
    const [row] = moved(root);
    const f = join(root, `${MAYA}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^area: personal$/m, "area: teaching"));
    gitRun(root, ["commit", "-qam", "owner: Maya under teaching"]);
    expect(undoFact(root, row!.undo_token).outcome).toBe("changed_since");
    expect(areaOf(root)).toBe("teaching");
    gitRun(root, ["rm", "-q", f]); gitRun(root, ["commit", "-qm", "owner: merged away"]);
    expect(undoFact(root, row!.undo_token).outcome).toBe("changed_since");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("after the move each assistant reads the page as its slices allow for the new area", async () => {
  try {
    const root = await brain();
    const reads = () => Object.fromEntries(["claude", "chatgpt", "gemini"].map((a) => [a, JSON.stringify(readNote(root, a, MAYA))]));
    const before = reads();
    // Gemini reads area:work in full and any person's org and role (contacts-basic): Maya's city
    // before the move, only her org and role after it.
    expect(before.gemini).toContain("Montréal");
    ownerSay(root, "Maya Chen works at Atelier Boréal");
    const after = reads();
    expect(after.gemini).not.toContain("Montréal");
    expect(after.gemini).toContain("design lead");
    // Claude reads everything and ChatGPT reads the personal area: both still see her city.
    expect(after.claude).toContain("Montréal");
    expect(after.chatgpt).toContain("Montréal");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("two org pages that both carry the workplace's name: the page never picks one, and follows once only one is left", async () => {
  try {
    const root = await brain();
    // An import's two-name org page and the real one both say "Brightwell".
    const org = (slug: string, title: string, area: string) => writeFileSync(join(root, "orgs", `${slug}.md`), `---\nid: orgs/${slug}\ntype: org\ntitle: ${title}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n`);
    org("brightwell", "Brightwell", "personal");
    org("northwind-brightwell", "Northwind / Brightwell", "teaching");
    gitRun(root, ["add", "-A"]); gitRun(root, ["commit", "-qm", "import: two orgs"]);
    ownerSay(root, "Maya Chen works at Brightwell");
    expect(areaOf(root)).toBe("work");
    expect(moved(root)).toHaveLength(0);
    // The import split leaves one page with the name: the owner's word then moves the page.
    gitRun(root, ["rm", "-q", "orgs/northwind-brightwell.md"]); gitRun(root, ["commit", "-qm", "import: split"]);
    setFact(root, MAYA, "org", "[[Brightwell]]");
    expect(areaOf(root)).toBe("personal");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("Undo of a move whose page lost its area line answers changed since and writes nothing, not even to a line in the text", async () => {
  try {
    const root = await brain();
    ownerSay(root, "Maya Chen works at Atelier Boréal");
    const [row] = moved(root);
    const f = join(root, `${MAYA}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^area: personal\n/m, "") + "\narea: personal\n");
    gitRun(root, ["commit", "-qam", "owner: no area line"]);
    const text = readFileSync(f, "utf8");
    expect(undoFact(root, row!.undo_token).outcome).toBe("changed_since");
    expect(readFileSync(f, "utf8")).toBe(text);
    expect(readDiary(root).some((r) => r.undoes === row!.undo_token)).toBe(false);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("an org page an assistant made never decides where a page moves (security review of #102)", async () => {
  try {
    const root = await brain();
    // ChatGPT reads the work area and makes the org page first, in that area.
    write(root, { agent: "chatgpt", type: "org", title: "Kestrel Works", area: "work", attribute: "what_it_is", value: "a print shop", as_of: "2026-10-08", sources: ["gmail:f00000000000d664"], verification: "verified-by-source" } as never);
    expect(loadBrain(root).some((n) => n.fm.type === "org" && n.fm.title === "Kestrel Works" && n.fm.area === "work")).toBe(true);
    ownerSay(root, "Hélène Lefebvre works at Kestrel Works");
    expect(areaOf(root, "people/helene-lefebvre")).toBe("personal");
    expect(moved(root)).toHaveLength(0);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("an assistant's org page that the owner accepted or filing saved never chooses the area (builder's slice audit of #102)", async () => {
  try {
    const root = await brain();
    // The commit is the owner's (an accepted proposal) or the hub's (filing), but the page is the assistant's.
    for (const [title, by] of [["Kestrel Works", "owner"], ["Larkspur Co", "auto-decide"]] as const) {
      write(root, { agent: "chatgpt", type: "org", title, area: "work", attribute: "what_it_is", value: "a print shop", as_of: "2026-10-08", sources: ["gmail:f00000000000d666"], verification: "verified-by-source" } as never, { acceptedBy: by });
      expect(loadBrain(root).some((n) => n.fm.type === "org" && n.fm.title === title && n.fm.area === "work")).toBe(true);
    }
    ownerSay(root, "Hélène Lefebvre works at Kestrel Works");
    expect(areaOf(root, "people/helene-lefebvre")).toBe("personal");
    ownerSay(root, "Hélène Lefebvre works at Larkspur Co");
    expect(areaOf(root, "people/helene-lefebvre")).toBe("personal");
    expect(moved(root)).toHaveLength(0);
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("a move that would hand the page to someone else's assistant (a share) leaves it where it is (builder's slice audit of #102)", async () => {
  try {
    const root = await brain();
    // Alex's assistant reads the personal area, shared by the owner.
    const { addShare } = await import("../src/share");
    addShare(root, { agent: "alex-ai", name: "Alex", slices: ["area:personal"], days: 30 } as never);
    ownerSay(root, "Maya Chen works at Atelier Boréal");
    expect(areaOf(root)).toBe("work");
    expect(moved(root)).toHaveLength(0);
  } finally { delete process.env.PB_NOW; }
}, 90_000);
