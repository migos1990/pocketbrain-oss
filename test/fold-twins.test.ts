// SPDX-License-Identifier: AGPL-3.0-only
// One thing, one page (owner's phone, 2026-11-03: Memory listed the same name twice; G635). A writer
// that files a page into an area it can't see gets a new page every time (G28: its reply never
// says a hidden page exists), so one project became two. The hub, which sees everything, folds a
// page into the older page with the same name, type, folder, area and level, with mergeNotes (no
// winner picked; a disagreement becomes a conflict), and Undo reverts it while neither page changed.
// The writer's reply is the same either way.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, saveNote } from "../src/brain";
import { git } from "../src/git";
import { findTwins, foldTwins, undoFold } from "../src/fold";
import { upkeep } from "../src/upkeep";
import { setFoldTwins } from "../src/ownerset";

const blind = (root: string, attribute: string, value: string) =>
  write(root, { agent: "planner", type: "project", title: "Garden planning", area: "personal", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
const pages = (root: string) => loadBrain(root).filter((n) => /garden-planning/.test(n.fm.id));

test("a writer blind to an area makes a twin with each write, and its replies look alike", () => {
  const root = makeBrain();
  const a = blind(root, "status", "active"), b = blind(root, "next_step", "book a session");
  expect(a.outcome).toBe("committed");
  expect(b.outcome).toBe("committed");
  expect(pages(root).filter((n) => n.fm.status === "active")).toHaveLength(2);
  expect(findTwins(loadBrain(root))).toHaveLength(1);
});

test("the hub folds the twin into the older page, and the writer's next reply is unchanged", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "next_step", "book a session");
  const dry = foldTwins(root, { apply: false });
  expect(dry.folds).toHaveLength(1);
  expect(dry.disputes).toBe(0);
  expect(pages(root).filter((n) => n.fm.status === "active")).toHaveLength(2); // a dry run changes nothing
  const r = foldTwins(root, { apply: true });
  expect(r.folds).toHaveLength(1);
  const live = pages(root).filter((n) => n.fm.status === "active");
  expect(live).toHaveLength(1);
  expect(Object.keys(live[0]!.fm.facts ?? {}).sort()).toEqual(["next_step", "status"]);
  expect(git(root, ["log", "-1", "--format=%an"])).toBe("reflect");
  // G28 holds: a third blind write answers exactly as the first two did, a new page id.
  const c = blind(root, "status", "paused");
  expect(c.outcome).toBe("committed");
  expect((c as { file?: string }).file ?? "").toMatch(/^projects\/garden-planning-[0-9a-f]{6}\.md$/);
});

test("Undo puts both pages back while neither changed since", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "next_step", "book a session");
  const before = pages(root).map((n) => n.fm.id).sort();
  const r = foldTwins(root, { apply: true });
  undoFold(root, r.folds[0]!.commit!);
  const after = pages(root).filter((n) => n.fm.status === "active").map((n) => n.fm.id).sort();
  expect(after).toEqual(before);
});

test("same name is not always the same thing: other levels, decisions, money and people never fold", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "next_step", "book a session");
  const [x] = pages(root);
  saveNote(root, { ...x!, fm: { ...x!.fm, sensitivity: "private" } });
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "private"]);
  expect(findTwins(loadBrain(root))).toHaveLength(0);
  expect(foldTwins(root, { apply: true }).folds).toHaveLength(0);
  // Another area is another wall: a fold never moves a fact across it.
  const rootA = makeBrain();
  blind(rootA, "status", "active");
  blind(rootA, "next_step", "book a session");
  const [y] = pages(rootA);
  saveNote(rootA, { ...y!, fm: { ...y!.fm, area: "work" } });
  git(rootA, ["add", "-A"]); git(rootA, ["commit", "-qm", "work"]);
  expect(findTwins(loadBrain(rootA))).toHaveLength(0);
  expect(foldTwins(rootA, { apply: true }).folds).toHaveLength(0);
  expect(pages(rootA).filter((n) => n.fm.status === "active")).toHaveLength(2);
  const root2 = makeBrain();
  for (const t of ["money", "decision", "person"]) {
    const n = { fm: { id: `${t === "person" ? "people" : t === "money" ? "money" : "decisions"}/same-${t}`, type: t, title: `Same ${t}`, area: "personal", sensitivity: "personal", status: "active", created: "2026-10-01", updated: "2026-10-01", by: "louis" }, body: "", path: "" } as never;
    saveNote(root2, n);
    saveNote(root2, { ...(n as object), fm: { ...(n as { fm: object }).fm, id: `${(n as { fm: { id: string } }).fm.id}-2` } } as never);
  }
  git(root2, ["add", "-A"]); git(root2, ["commit", "-qm", "twins"]);
  expect(findTwins(loadBrain(root2))).toHaveLength(0);
});

test("a refused fold leaves both pages as they were and says so once, naming nothing", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "status", "paused");
  // Two values for one fact wait as a conflict first: an open dispute on either page holds the fold.
  const [a] = pages(root);
  saveNote(root, { fm: { id: "disputes/c-0900", type: "dispute", title: `${a!.fm.id}#status`, area: "personal", sensitivity: "personal", status: "open", created: "2026-10-06", updated: "2026-10-06", by: "reflect", fact_key: `${a!.fm.id}#status` } as never, body: "", path: "" });
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "dispute"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const r = foldTwins(root, { apply: true });
  expect(r.folds).toHaveLength(0);
  expect(r.refused).toHaveLength(1);
  // The owner's dry run names the conflict to settle first, so the Mac can say which card unblocks it.
  expect(r.refused[0]!.why).toContain("disputes/c-0900");
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
  const u = upkeep(root, { run: "t" });
  const f = u.findings.filter((x) => x.rule === "twin-held");
  expect(f).toHaveLength(1);
  expect(f[0]!.detail).not.toContain("Fitness");
  expect(f[0]!.detail).not.toContain("fitness");
});

test("upkeep folds twins by default before page text (the owner's word, 2026-11-03), and only counts them once the owner turns it off", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "next_step", "book a session");
  const u = upkeep(root, { run: "t1" });
  expect(pages(root).filter((n) => n.fm.status === "active")).toHaveLength(1);
  const f = u.findings.find((x) => x.rule === "twin-fold")!;
  // The finding says how to undo it, with the fold's own commit, and names no page.
  expect(f.detail).toMatch(/pocketbrain fold undo [0-9a-f]{8}`/);
  expect(f.detail).not.toContain("garden");
  const root2 = makeBrain();
  setFoldTwins(root2, "off");
  blind(root2, "status", "active");
  blind(root2, "next_step", "book a session");
  const off = upkeep(root2, { run: "t2" });
  expect(pages(root2).filter((n) => n.fm.status === "active")).toHaveLength(2);
  const would = off.findings.find((x) => x.rule === "twin-would-fold")!;
  expect(would.key).toBe("twin-would-fold");
  expect(would.detail).toContain("pocketbrain fold on");
});

test("a dry run of three twins counts each fold against the page as the earlier folds left it", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "status", "paused");
  blind(root, "status", "paused");
  // Pages two and three agree with each other and not with the first: one conflict, not two,
  // and the dry run says what --apply does.
  const dry = foldTwins(root, { apply: false });
  const r = foldTwins(root, { apply: true });
  expect([dry.folds.length, dry.refused.length, dry.disputes]).toEqual([r.folds.length, r.refused.length, r.disputes]);
  expect([r.folds.length + r.refused.length, r.disputes]).toEqual([2, 1]);
});

test("the page that stays is the one other pages link to, and a word is never mistaken for a suffix", () => {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "next_step", "book a session");
  const [a, b] = pages(root).sort((x, y) => y.fm.id.localeCompare(x.fm.id));
  saveNote(root, { fm: { id: "projects/linker", type: "project", title: "Linker", area: "personal", sensitivity: "personal", status: "active", created: "2026-10-01", updated: "2026-10-01", by: "louis" } as never, body: `See [[${a!.fm.id}]].`, path: "" });
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "link"]);
  expect(findTwins(loadBrain(root))).toEqual([{ keep: a!.fm.id, drop: b!.fm.id }]);
});
