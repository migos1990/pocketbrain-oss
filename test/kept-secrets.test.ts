// SPDX-License-Identifier: AGPL-3.0-only
// G991, second half: a saved value that holds a code or password stays in the memory after the
// screens hide it. The night pass counts such values (no value, no page named) and changes nothing
// until the owner turns it on (`pocketbrain saved-codes on`); then each is set aside with a diary
// line and Undo: alone, one of several on a list, or a side of a question, which closes as its other
// side. The owner's own word is never taken, and what the owner brought back is never taken again.
// Invented pages; the codes are built at run time so no code-shaped string sits in the repo.
import { test, expect, afterAll } from "bun:test";
import { writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, isList, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { upkeep } from "../src/upkeep";
import { ownerConflicts } from "../src/core";
import { setSavedCodes } from "../src/ownerset";
import { setAsideKeptSecrets } from "../src/kept-secrets";
import { homeView } from "../src/dashboard/home";
import { notePage } from "../src/dashboard/html-brain";
import { loadState } from "../src/dashboard/data";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const CODE = ["TR4W", "9KLM", "2XPQD", "6FJ8", "3C7N"].join("-");
const CODE2 = ["LW5B", "7YHG", "4MNRT", "8DK2", "5V6Z"].join("-");
const VOUCHER = `Show voucher ${CODE} at the pool gate`;
const LOCKER = `Locker combination card says ${CODE2} for the east row`;
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "o@x" } });
const rec = (value: string, by = "planner", extra = "") => `{ value: ${JSON.stringify(value)}, as_of: 2026-10-05, sources: ["gmail:f0000000000000a7"], verification: verified-by-source, by: ${by}, recorded: 2026-10-05${extra} }`;
const page = (id: string, title: string, facts: string[]) => `---\nid: ${id}\ntype: project\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-05\nby: planner\nfacts:\n${facts.map((f) => `  ${f}`).join("\n")}\n---\n\nNotes kept by hand: ${VOUCHER}.\n`;

function rig(o: { question?: boolean } = {}) {
  const root = makeBrain(); roots.push(root);
  // One plain value, one of two on a list, and the owner's own word holding a code (left alone).
  writeFileSync(join(root, "projects", "swim-club.md"), page("projects/swim-club", "Swim club", [
    `entry: ${rec(VOUCHER)}`,
    `kit:\n    items:\n      - ${rec("Bring a towel and a cap")}\n      - ${rec(LOCKER)}`,
    `gate: { value: ${JSON.stringify(VOUCHER)}, as_of: 2026-10-02, sources: ["owner:2026-10-02/box"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-02 }`,
  ]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: swim club");
  if (o.question) {
    const HOLD = "paper-slip", old = VOUCHER.replace(CODE, HOLD);
    writeFileSync(join(root, "projects", "lane-b.md"), page("projects/lane-b", "Lane B", [`room: ${rec(old)}`]));
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: lane b");
    const r = write(root, { agent: "planner", id: "projects/lane-b", attribute: "room", value: "B-204", as_of: "2026-10-08", sources: ["gcal:e9@e9"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
    expect(r.outcome).toBe("disputed");
    for (const dir of ["projects", "disputes"]) for (const f of readdirSync(join(root, dir))) {
      const file = join(root, dir, f), text = readFileSync(file, "utf8");
      if (text.includes(HOLD)) writeFileSync(file, text.split(HOLD).join(CODE));
    }
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "an old brain's files");
  }
  return root;
}
const facts = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!.fm.facts!;

test("G991: off by default, the night pass only counts, names nothing and changes nothing", () => {
  const root = rig({ question: true });
  const before = readFileSync(join(root, "projects", "swim-club.md"), "utf8"), asks = ownerConflicts(root, new Date(), { held: true }).length;
  expect(setAsideKeptSecrets(root, false)).toEqual({ facts: 3, pages: 2 });
  const run = JSON.stringify(upkeep(root));
  expect(run).toMatch(/3 saved values on 2 pages hold a code or password/);
  expect(run).not.toContain(CODE);
  expect(run).not.toContain(CODE2);
  expect(readFileSync(join(root, "projects", "swim-club.md"), "utf8")).toBe(before);
  expect(ownerConflicts(root, new Date(), { held: true }).length).toBe(asks);
  expect(readDiary(root).filter((r) => r.why === "secret")).toEqual([]);
});

test("G991: turned on, a plain value and a list item are set aside with Undo; the owner's word stays", () => {
  const root = rig();
  setSavedCodes(root, "on");
  upkeep(root);
  const f = facts(root, "projects/swim-club");
  expect(f.entry).toBeUndefined();
  expect(isList(f.kit!) && f.kit.items.filter((i) => !i.valid_to).map((i) => i.value)).toEqual(["Bring a towel and a cap"]);
  expect((f.gate as FactRecord).value).toBe(VOUCHER);
  const rows = readDiary(root).filter((r) => r.why === "secret");
  expect(rows.map((r) => r.fact_key).sort()).toEqual(["projects/swim-club#entry", "projects/swim-club#kit"]);
  // The home says it was set aside and never prints the code.
  const home = JSON.stringify(homeView(root, loadRules(root), loadBrain(root), new Date()));
  expect(home).toMatch(/A saved code or password on Swim club was set aside/);
  expect(home).not.toContain(CODE);
  expect(home).not.toContain(CODE2);
  // Undo brings each back as it was, and the next night leaves it alone.
  for (const r of rows) expect(undoFact(root, r.undo_token!).outcome).toBe("undone");
  upkeep(root);
  const g = facts(root, "projects/swim-club");
  expect((g.entry as FactRecord).value).toBe(VOUCHER);
  expect(isList(g.kit!) && g.kit.items.filter((i) => !i.valid_to).length).toBe(2);
});

test("G991: turned on, a question with one such side closes as its other side, and Undo opens it again", () => {
  const root = rig({ question: true });
  expect(ownerConflicts(root, new Date(), { held: true }).length).toBe(1);
  setSavedCodes(root, "on");
  upkeep(root);
  expect(ownerConflicts(root, new Date(), { held: true }).length).toBe(0);
  expect((facts(root, "projects/lane-b").room as FactRecord).value).toBe("B-204");
  const row = readDiary(root).find((r) => r.why === "secret" && r.fact_key === "projects/lane-b#room")!;
  expect(row.kind).toBe("settled");
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  expect(ownerConflicts(root, new Date(), { held: true }).length).toBe(1);
  // The question the owner opened again is left open the next night.
  upkeep(root);
  expect(ownerConflicts(root, new Date(), { held: true }).length).toBe(1);
});

test("G991: the Settings note view shows the mark where a value or the notes hold a code", () => {
  const root = rig();
  const s = loadState(root), n = s.notes.find((x) => x.fm.id === "projects/swim-club")!;
  const html = notePage(s, "t", n, readFileSync(join(root, n.path), "utf8")).body;
  const shown = [...html.matchAll(/class="b-(?:val|show|text)"[^>]*>([^<]*)/g)].map((m) => m[1]).join("\n") + (html.match(/id="b-text"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
  expect(shown).toContain("Show voucher •••• at the pool gate");
  expect(shown).not.toContain(CODE);
  expect(shown).not.toContain(CODE2);
});

test("G991: another code that later stands on a fact set aside once is still counted and taken; only what the owner brought back is left", () => {
  const root = rig();
  setSavedCodes(root, "on");
  upkeep(root);
  const rows = readDiary(root).filter((r) => r.why === "secret");
  // The owner brings the list item back; a different code is put on the plain fact by hand.
  expect(undoFact(root, rows.find((r) => r.fact_key.endsWith("#kit"))!.undo_token!).outcome).toBe("undone");
  const file = join(root, "projects", "swim-club.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("facts:\n", `facts:\n  entry: ${rec(LOCKER.replace("east", "west"))}\n`));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: by hand");
  expect(setAsideKeptSecrets(root, false)).toEqual({ facts: 1, pages: 1 });
  upkeep(root);
  const f = facts(root, "projects/swim-club");
  expect(f.entry).toBeUndefined();
  expect(isList(f.kit!) && f.kit.items.filter((i) => !i.valid_to).length).toBe(2);
});
