// SPDX-License-Identifier: AGPL-3.0-only
// The wiki shape, read-only (docs/wiki.md): a one-line summary, a parent, the page tree computed
// from parents, sections from ## headings and Markdown footnotes. Old notes have none of it.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type Note } from "../src/brain";
import { pageTree, ancestors, sections, footnotes, summaryOf, wikiLint as lint, recentUpdates } from "../src/wiki";
import { git } from "../src/git";
import { upkeep } from "../src/upkeep";
import { loadState } from "../src/dashboard/data";
import { notePage } from "../src/dashboard/html-brain";

const note = (id: string, title: string, fm: Record<string, unknown> = {}, body = ""): Note =>
  ({ fm: { id, type: "note", title, area: "work", sensitivity: "personal", status: "active", created: "2026-10-01", updated: "2026-10-01", by: "owner", ...fm }, body, path: `${id}.md` }) as Note;

test("the tree comes from parent: children by title, roots, and parents that point nowhere or loop are roots", () => {
  const ns = [
    note("notes/overview", "Overview"),
    note("people/zoe", "Zoe", { parent: "notes/overview" }),
    note("people/abe", "Abe", { parent: "notes/overview" }),
    note("projects/a", "A", { parent: "people/abe" }),
    note("projects/lost", "Lost", { parent: "notes/nowhere" }),
    note("projects/x", "X", { parent: "projects/y" }),
    note("projects/y", "Y", { parent: "projects/x" }),
    note("projects/self", "Self", { parent: "projects/self" }),
  ];
  const t = pageTree(ns);
  expect(t.children.get("notes/overview")).toEqual(["people/abe", "people/zoe"]);
  expect(t.children.get("people/abe")).toEqual(["projects/a"]);
  expect(t.roots).toContain("notes/overview");
  expect(t.roots).toContain("projects/lost");
  expect(t.roots).toContain("projects/self");
  expect(t.roots).not.toContain("people/zoe");
  expect(t.broken.sort()).toEqual(["projects/lost", "projects/self", "projects/x", "projects/y"]);
  expect(ancestors(ns, "projects/a")).toEqual(["notes/overview", "people/abe"]);
  expect(ancestors(ns, "projects/x")).toEqual([]);
  expect(ancestors(ns, "notes/overview")).toEqual([]);
});

test("sections split on ## headings; text before the first heading has none", () => {
  expect(sections("Intro line.\n\n## Who they are\nA teacher.\n\n## Open threads\n- one\n")).toEqual([
    { heading: undefined, text: "Intro line." },
    { heading: "Who they are", text: "A teacher." },
    { heading: "Open threads", text: "- one" },
  ]);
  expect(sections("")).toEqual([]);
  expect(sections("### small\nnot a section")).toEqual([{ heading: undefined, text: "### small\nnot a section" }]);
});

test("footnotes: definitions leave the text, refs keep their order, unknown refs stay as written", () => {
  const f = footnotes("Grades by Oct 14.[^mail] Review after.[^2] Odd [^none].\n\n[^mail]: Email, Oct 2\n[^2]: Calendar, Oct 3");
  expect(f.text).toBe("Grades by Oct 14.[^mail] Review after.[^2] Odd [^none].");
  expect(f.notes).toEqual([{ label: "mail", n: 1, text: "Email, Oct 2" }, { label: "2", n: 2, text: "Calendar, Oct 3" }]);
});

test("summary is one trimmed line; a non-string or blank one is none", () => {
  expect(summaryOf(note("a/b", "B", { summary: "  Coordinates Course A.\nsecond line " }))).toBe("Coordinates Course A.");
  expect(summaryOf(note("a/b", "B", { summary: 7 }))).toBeUndefined();
  expect(summaryOf(note("a/b", "B", { summary: "   " }))).toBeUndefined();
  expect(summaryOf(note("a/b", "B"))).toBeUndefined();
});

test("the owner's note page shows the summary, the path up the tree, sections, footnotes and the pages under it", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8")
    .replace("aliases: [Jane]", "aliases: [Jane]\nsummary: Coordinates Course A at Northfield.\nparent: projects/course-a")
    .replace(/---\n(Coordinates[^\n]*)\n?$/, "---\n$1\n\n## Open threads\nSyllabus draft due.[^1]\n\n[^1]: Email, Oct 2 <script>\n"));
  const s = loadState(root);
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  const course = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!;
  const html = notePage(s, "x", jane, "").body;
  expect(html).toContain("Coordinates Course A at Northfield.");
  expect(html).toMatch(/b-crumbs[^]*href="\/p\/projects\/course-a"[^]*<\/div>/);
  expect(html).toContain("<h3>Open threads</h3>");
  expect(html).toMatch(/<sup><a href="#fn-1"[^>]*>\[1\]<\/a><\/sup>/);
  expect(html).toContain('id="fn-1"');
  expect(html).toContain("Email, Oct 2 &lt;script&gt;");
  // The shown text, not the edit box (which keeps the raw Markdown).
  expect(html.split('id="b-text"')[1].split("<form")[0]).not.toContain("[^1]");
  expect(notePage(s, "x", course, "").body).toMatch(/Pages under this[^]*Jane Roy/);
  // A note with none of it renders as before: no summary line, no references list.
  const plain = notePage(s, "x", loadBrain(root).find((n) => n.fm.id === "people/paul-advisor")!, "").body;
  expect(plain).not.toContain("b-summary");
  expect(plain).not.toContain("References");
});

// Slice 2: the wiki's lint rules, review findings only, no model and no edits.
test("wiki lint: uncited lines in a page's sections, refs no fact cites, a broken parent, orphans and a missing hub", () => {
  const fact = (ref: string) => ({ value: "x", as_of: "2026-10-01", sources: [ref], verification: "verified-by-source", by: "owner", recorded: "2026-10-01" });
  const page = note("people/maya", "Maya", { summary: "A colleague.", facts: { role: fact("gmail:f000000000000001") } },
    "Intro, not in a section.\n\n## Who they are\nTeaches Course A.[^1]\nRuns the lab.\n\n## Open threads\n- Old thread.[^2]\n\n[^1]: Email, Oct 1 (gmail:f000000000000001)\n[^2]: Email, Sep 2 (gmail:f00000000000000f)");
  const legacy = note("people/old", "Old", {}, "## Notes\nNo refs here, and that's fine: not a wiki page.");
  const lost = note("projects/lost", "Lost", { parent: "notes/nowhere" });
  const noHub = lint([page, legacy, lost]);
  expect(noHub).toContainEqual({ rule: "uncited-line", key: "people/maya", kind: "review", detail: "1 line with no reference, in Who they are" });
  expect(noHub).toContainEqual({ rule: "section-drift", key: "people/maya", kind: "review", detail: "reference 2 cites gmail:f00000000000000f, which none of this page's facts cite now" });
  expect(noHub).toContainEqual({ rule: "parent-broken", key: "projects/lost", kind: "review", detail: "parent: notes/nowhere is missing or loops back" });
  expect(noHub).toContainEqual({ rule: "missing-hub", key: "notes/overview", kind: "review", detail: "pages use summary: or parent:, but no page has type: hub" });
  expect(noHub.some((f) => f.key === "people/old")).toBe(false);
  expect(noHub.some((f) => f.rule === "orphan")).toBe(false);
  // Once a hub exists, a page nothing links to and with no parent or pages under it is an orphan.
  const hub = note("notes/overview", "Overview", { type: "hub" }, "Start with [[people/maya]].");
  const withHub = lint([hub, page, legacy, lost]);
  expect(withHub.some((f) => f.rule === "missing-hub")).toBe(false);
  expect(withHub).toContainEqual({ rule: "orphan", key: "people/old", kind: "review", detail: "no page links here, and it has no parent: and no pages under it" });
  expect(withHub.some((f) => f.rule === "orphan" && ["people/maya", "notes/overview"].includes(f.key))).toBe(false);
  // Details name pages, sections and refs, never a line's text.
  expect(JSON.stringify(withHub)).not.toMatch(/Runs the lab|Teaches|Old thread/);
});

test("upkeep runs the wiki lint and lists its findings for review", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("aliases: [Jane]", "aliases: [Jane]\nsummary: Coordinates Course A.").replace(/---\n(Coordinates[^\n]*)\n?$/, "---\n$1\n\n## Open threads\nNo ref on this line.\n"));
  const r = upkeep(root, { run: "reflect-wiki" });
  expect(r.findings).toContainEqual({ rule: "uncited-line", key: "people/jane-roy", kind: "review", detail: "1 line with no reference, in Open threads" });
  expect(readFileSync(join(root, r.file), "utf8")).toContain("[uncited-line] `people/jane-roy`");
});

// Slice 3: Recent updates, one plain line per page touched, never a value or a line's text.
test("recent updates name the page and the kind of change, never the value or the text", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  const edit = (from: RegExp | string, to: string, msg: string) => {
    writeFileSync(f, readFileSync(f, "utf8").replace(from, to));
    git(root, ["add", "people/jane-roy.md"]);
    git(root, ["commit", "-q", "-m", msg, "--", "people/jane-roy.md"], "owner");
  };
  edit("role: { value: Course coordinator,", "role: { value: Associate Dean Zebrafish,", "owner: role");
  edit("aliases: [Jane]", "aliases: [Jane]\nsummary: Leads the Quokka lab.", "owner: summary");
  edit(/\n?$/, "\n\n## Open threads\nSecret plan Wombat.\n", "owner: section");
  edit("Secret plan Wombat.", "Secret plan Platypus.", "owner: section text");
  const lines = recentUpdates(root, loadBrain(root));
  expect(lines.slice(0, 4).map((l) => l.text)).toEqual([
    "Edited the Open threads section of Jane Roy",
    "Added an Open threads section to Jane Roy",
    "Added a summary to Jane Roy",
    "Changed the Role fact on Jane Roy",
  ]);
  // git writes the owner as the brain's owner.name (Robin in the sample brain).
  expect(lines[0]).toMatchObject({ id: "people/jane-roy", by: "Robin" });
  expect(JSON.stringify(lines)).not.toMatch(/Zebrafish|Quokka|Wombat|Platypus|Associate Dean|Course coordinator/);
  // One page's own lines, and a filter for who may see which page.
  expect(recentUpdates(root, loadBrain(root), { id: "projects/course-a" }).every((l) => l.id === "projects/course-a")).toBe(true);
  expect(recentUpdates(root, loadBrain(root), { visible: (id) => id !== "people/jane-roy" }).some((l) => l.id === "people/jane-roy")).toBe(false);
});

test("a hub page shows the brain's recent updates; a page shows its own", () => {
  const root = makeBrain();
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "overview.md"), "---\nid: notes/overview\ntype: hub\ntitle: Overview\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nStart here.\n");
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("role: { value: Course coordinator,", "role: { value: Dean,"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "owner: two pages"], "owner");
  const s = loadState(root);
  const ns = loadBrain(root);
  const hub = notePage(s, "x", ns.find((n) => n.fm.id === "notes/overview")!, "").body;
  expect(hub).toMatch(/Recent updates[^]*Changed the Role fact on Jane Roy/);
  expect(hub).toContain("New page: Overview");
  const jane = notePage(s, "x", ns.find((n) => n.fm.id === "people/jane-roy")!, "").body;
  expect(jane).toMatch(/Recent updates[^]*Changed the Role fact on Jane Roy/);
  expect(jane).not.toContain("New page: Overview");
});
