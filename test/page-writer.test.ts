// SPDX-License-Identifier: AGPL-3.0-only
// The page writer (src/wiki.ts renderTouchedPages, docs/wiki.md "Every page gets text"): every
// page a commit touched gets an opening paragraph from its facts, each sentence citing its source,
// with links to the pages its sources name, never past what a reader of the page may see.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { nameKey, nameKeys } from "../src/mentions";
import { pullSource } from "../src/pull";
import { nightPageText } from "../src/start";
import { makeModel, type ModelRequest } from "../src/model";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const SINCE = "2000-01-01T00:00:00Z";

function person(root: string, slug: string, title: string, facts: string, o: { sensitivity?: string; area?: string } = {}) {
  writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: ${o.area ?? "work"}\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n${facts}---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", `planner: ${slug}`);
}
const fact = (attr: string, value: string, ref: string, extra = "") => `  ${attr}: { value: ${value}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: planner, recorded: 2026-10-05${extra} }\n`;
function capture(root: string, ref: string, names: string[]) {
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", `2026-10-05-${ref.slice(-8)}.md`), `---\n${YAML.stringify({ id: `2026-10-05-${ref.slice(-8)}`, kind: "text", via: "source", source_ref: ref, name_keys: names.map(nameKey), status: "extracted" })}---\nNot kept here.\n`);
  sh(root, "hub", "add", "-A"); sh(root, "hub", "commit", "-qm", "capture");
}

test("page writer: a touched page gets one cited sentence per fact; a second run commits nothing", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1") + fact("org", "North College", "gmail:f0000000000000a2"));
  const r = renderTouchedPages(root, SINCE);
  expect(r.written).toContain("people/ana-diaz");
  const b = body(root, "people/ana-diaz");
  // Role and org are one sentence with both references (G559).
  expect(b).toContain("Ana Diaz is the program director at North College.[^pf-role][^pf-org]");
  expect(b).toMatch(/^\[\^pf-role\]: Email, 2026-10-05 \(gmail:f0000000000000a1\)$/m);
  const log = sh(root, "hub", "log", "-1", "--format=%an%n%B");
  expect(log.split("\n")[0]).toBe("hub");
  expect(log).toMatch(/^Why: /m);
  const head = sh(root, "hub", "rev-parse", "HEAD");
  expect(renderTouchedPages(root, SINCE).written).toEqual([]);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(head);
});

test("page writer: opening text in the owner's commit is kept word for word, on top, the facts beneath (G682)", () => {
  const root = makeBrain();
  sh(root, "louis", "commit", "-q", "--allow-empty", "-m", "touch");
  writeFileSync(join(root, "people", "jane-roy.md"), readFileSync(join(root, "people", "jane-roy.md"), "utf8").replace("updated: 2026-10-01", "updated: 2026-10-02"));
  sh(root, "louis", "commit", "-qam", "owner: touch jane");
  const before = body(root, "people/jane-roy");
  const r = renderTouchedPages(root, SINCE);
  expect(r.kept).toContain("people/jane-roy");
  expect(body(root, "people/jane-roy")).toStartWith(`${before.split("\n\n[^")[0]}\n\n## From its facts\nJane Roy's role is Course coordinator.[^pf-role]`);
  expect(body(root, "people/jane-roy")).not.toContain("## Earlier notes");
});

test("page writer: text another writer left, even one upkeep later repointed, is kept on top (G682)", () => {
  const root = makeBrain();
  const c = join(root, "projects", "course-a.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\n---\n[\s\S]*$/, "\n---\nTA is [[people/jane-roy]].\n"));
  sh(root, "planner", "commit", "-qam", "planner: course a");
  writeFileSync(c, readFileSync(c, "utf8").replace("[[people/jane-roy]]", "[[people/jane-roy|Jane]]"));
  sh(root, "reflect", "commit", "-qam", "reflect: repoint links in projects/course-a");
  expect(renderTouchedPages(root, SINCE).kept).toContain("projects/course-a");
  expect(body(root, "projects/course-a")).toStartWith("TA is [[people/jane-roy|Jane]].\n\n## From its facts\n");
});

test("page writer: a fact a reader of the page can't see stays out of its text", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1") + fact("health_note", "on leave", "gmail:f0000000000000a3", ", sensitivity: private"));
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).toContain("program director");
  expect(b).not.toContain("on leave");
  expect(b).not.toContain("gmail:f0000000000000a3");
});

test("page writer: links the pages a fact's source names, only where every reader of the page sees them", () => {
  const root = makeBrain();
  person(root, "ben-okafor", "Ben Okafor", fact("role", "lab manager", "gmail:f0000000000000b1"));
  person(root, "eve-hidden", "Eve Hidden", fact("role", "lawyer", "gmail:f0000000000000b2"), { sensitivity: "private" });
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  capture(root, "gmail:f0000000000000a1", ["Ben Okafor", "Eve Hidden", "Ana Diaz"]);
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).toContain("Its sources also name [[people/ben-okafor|Ben Okafor]].[^pf-role]");
  // helper sees Ana's text (area work) but not a private page: no link, no name.
  expect(b).not.toContain("Eve");
});

test("page writer: a pulled item keeps hashes of the names it uses, never the words", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "test", sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  writeFileSync(join(root, "c.json"), JSON.stringify([{ id: "e1", etag: '"e1"', summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: "Jane Roy (person) role: Program lead, with Robin Quist", updated: "2026-10-07T00:00:00Z", calendar: "primary" }]));
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: sources");
  const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): ([^,]+)/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
  await pullSource(root, "cal", { model });
  const dir = join(root, "inbox", "captures");
  const rec = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).find((t) => t.includes("gcal:"))!;
  expect(rec).toContain(nameKey("Robin Quist"));
  expect(rec).not.toContain("Robin");
  expect(nameKeys("met Robin Quist at North College")).toEqual(expect.arrayContaining([nameKey("Robin Quist"), nameKey("North College"), nameKey("robin  quist")]));
});

test("page writer: the night writes page text even when a managed Gardener does upkeep", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  expect(nightPageText(root, true)).toBeUndefined();
  expect(nightPageText(root, false)?.written).toContain("people/ana-diaz");
  expect(body(root, "people/ana-diaz")).toContain("Ana Diaz's role is program director.");
});

// Mail read before the hub kept name keys (2026-10-26) links nothing: each night the hub re-reads
// a few of the sources the touched pages cite, through the listed source, and keeps hashes only.
test("page writer: a source read before name keys gets them at night, capped, hashes only", async () => {
  const { backfillNameKeys } = await import("../src/wiki");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "test", sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  const mail = (id: string, text: string) => ({ id, threadId: id, internalDate: String(Date.parse("2026-10-05T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "C <c@example.org>" }, { name: "Subject", value: "hi" }] }, text });
  writeFileSync(join(root, "m.json"), JSON.stringify([mail("00000000000000a1", "Ana Diaz is now the program director, working with Ben Okafor."), mail("00000000000000a2", "Ana Diaz works at North College.")]));
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: sources");
  person(root, "ben-okafor", "Ben Okafor", fact("role", "lab manager", "gmail:00000000000000b1"));
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:00000000000000a1") + fact("org", "North College", "gmail:00000000000000a2"));
  expect((await backfillNameKeys(root, SINCE, 1)).read).toBe(1);
  expect((await backfillNameKeys(root, SINCE, 5)).read).toBe(1); // the rest, never one twice
  expect((await backfillNameKeys(root, SINCE, 5)).read).toBe(0);
  const kept = readFileSync(join(root, "log", "sources", "name-keys.jsonl"), "utf8");
  expect(kept).toContain(nameKey("Ben Okafor"));
  expect(kept).not.toContain("Ben");
  renderTouchedPages(root, SINCE);
  expect(body(root, "people/ana-diaz")).toContain("Its sources also name [[people/ben-okafor|Ben Okafor]].[^pf-role]");
});

test("shipped defaults: a new brain links names in its text (link_names on)", async () => {
  const { initBrain } = await import("../src/init");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "pb-init-"));
  initBrain(root, { owner: "Sam Lee", me: ["sam@example.org"], token: false });
  expect(YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).link_names).toBe(true);
});

// The phone check, 2026-10-26: an org shown as "[[Town]]", references as raw ids, and two
// references on one sentence reading as "12".
test("note page: a page-writer page reads as words: linked names, dated references, separate numbers", async () => {
  const { notePage } = await import("../src/dashboard/html-brain");
  const { loadState } = await import("../src/dashboard/data");
  const { loadBrain } = await import("../src/brain");
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `---\nid: orgs/north-college\ntype: org\ntitle: North College\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  person(root, "ben-okafor", "Ben Okafor", fact("role", "lab manager", "gmail:f0000000000000b1"));
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1") + fact("org", "\"[[North College]]\"", "owner:2026-10-05/dashboard") + fact("last_contact", "2026-10-05", "gmail:f0000000000000a1"));
  capture(root, "gmail:f0000000000000a1", ["Ben Okafor"]);
  renderTouchedPages(root, SINCE);
  expect(body(root, "people/ana-diaz")).toContain("Ana Diaz is the program director at [[orgs/north-college|North College]].");
  const ana = loadBrain(root).find((n) => n.fm.id === "people/ana-diaz")!;
  const html = notePage(loadState(root), "x", ana, "").body;
  // The edit form keeps the raw value; what the page shows never has brackets.
  const shown = html.replace(/<form[\s\S]*?<\/form>/g, "");
  expect(shown).not.toContain("[[");
  expect(shown).toContain(">North College</a>");
  // role and last_contact cite the same email: one footnote, not two.
  expect(shown.match(/Email, 5 Oct 2026/g)?.length).toBe(1);
  expect(html).toContain("Your note, 5 Oct 2026");
  expect(html).toContain("Email, 5 Oct 2026");
  expect(shown).not.toMatch(/>gmail:|\(gmail:/);
  expect(html).toMatch(/>\[1\]<\/a><\/sup>/);
}, 30_000);

// Phone check, 2026-10-26 10:42Z: a relationship read "Relationship of <name>: sent <owner> a
// request for feedback …", the sources line named again the org the text linked two lines up,
// and only 15 of 92 touched pages had a link in.
test("page writer: what someone did reads as a sentence to you; a linked page isn't named twice; an org lists who works there", () => {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `---\nid: orgs/north-college\ntype: org\ntitle: North College\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  person(root, "ben-okafor", "Ben Okafor", fact("org", "\"[[North College]]\"", "gmail:f0000000000000b1"));
  person(root, "ana-diaz", "Ana Diaz", fact("relationship", "sent Robin a request for feedback on Robin's grant plan", "gmail:f0000000000000a1") + fact("org", "\"[[North College]]\"", "gmail:f0000000000000a1"));
  person(root, "cy-moss", "Cy Moss", fact("relationship", "former manager", "gmail:f0000000000000c1"));
  capture(root, "gmail:f0000000000000a1", ["Ben Okafor", "North College"]);
  renderTouchedPages(root, SINCE);
  const ana = body(root, "people/ana-diaz");
  expect(ana).toContain("Ana Diaz sent you a request for feedback on your grant plan.[^pf-relationship]");
  expect(ana).not.toContain("Relationship of");
  // Ben, whom Ana's mail names, is at her org: the sentence that says so names him, once (G687).
  expect(ana).toContain("Also at [[orgs/north-college|North College]]: [[people/ben-okafor|Ben Okafor]].");
  expect(ana).not.toContain("Its sources also name [[people/ben-okafor");
  expect(ana).not.toMatch(/also name[^\n]*North College/);
  expect(body(root, "people/cy-moss")).toContain("How you know Cy Moss: former manager.");
  // The org page wasn't touched by a fact of its own: its people's org facts name it.
  const org = body(root, "orgs/north-college");
  expect(org).toContain("[[people/ana-diaz|Ana Diaz]] and [[people/ben-okafor|Ben Okafor]] work at North College.");
  expect(org).toMatch(/^\[\^pf?-[a-z-]+\]: Email, 2026-10-05 \(gmail:f0000000000000a1\)$/m);
});

test("page writer: an org never lists a person some reader of the org page can't see", () => {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `---\nid: orgs/north-college\ntype: org\ntitle: North College\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  person(root, "dee-ray", "Dee Ray", fact("org", "\"[[North College]]\"", "gmail:f0000000000000d1"), { sensitivity: "private" });
  renderTouchedPages(root, SINCE);
  expect(body(root, "orgs/north-college")).not.toContain("Dee Ray");
});

// Inbound links, 2026-10-26: 15 of 92 touched pages had a link in; a page named in someone's
// mail links back to them, from the same name keys.
test("page writer: a page named in another page's source links back to it, cited; never past a reader", () => {
  const root = makeBrain();
  person(root, "ben-okafor", "Ben Okafor", "");
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  person(root, "eve-park", "Eve Park", fact("role", "counsel", "gmail:f0000000000000e1", ", sensitivity: private"));
  capture(root, "gmail:f0000000000000a1", ["Ben Okafor"]);
  capture(root, "gmail:f0000000000000e1", ["Ben Okafor"]);
  const r = renderTouchedPages(root, SINCE);
  expect(r.written).toContain("people/ben-okafor");
  const ben = body(root, "people/ben-okafor");
  expect(ben).toContain("Ben Okafor also comes up in the sources of [[people/ana-diaz|Ana Diaz]].[^p-in-ana-diaz]");
  expect(ben).toMatch(/^\[\^p-in-ana-diaz\]: Email, 2026-10-05 \(gmail:f0000000000000a1\)$/m);
  // A private fact's source never names its page on a less private one.
  expect(ben).not.toContain("Eve Park");
  // Ana's page names Ben; Ben's names Ana: one link each way, not repeated on either.
  expect(body(root, "people/ana-diaz")).toContain("Its sources also name [[people/ben-okafor|Ben Okafor]].");
});

// Real-brain north star, 2026-10-30: 8 of 9 touched pages with no link in linked out nowhere; 2 of
// them shared a source item with another page that no name keys tied them by. Two pages drawn from
// the same email link to each other, cited by it, when that email names them (G624: a receipt or
// newsletter behind two pages is not about either); never past a reader.
test("page writer: pages whose facts cite the same item link to each other, cited; never past a reader", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000c1"));
  person(root, "cy-moss", "Cy Moss", fact("role", "registrar", "gmail:f0000000000000c1"));
  person(root, "eve-park", "Eve Park", fact("role", "counsel", "gmail:f0000000000000c1", ", sensitivity: private"));
  capture(root, "gmail:f0000000000000c1", ["Ana Diaz", "Cy Moss"]);
  renderTouchedPages(root, SINCE);
  const cy = body(root, "people/cy-moss"), ana = body(root, "people/ana-diaz");
  expect(cy).toContain("[[people/ana-diaz|Ana Diaz]]");
  expect(ana).toContain("[[people/cy-moss|Cy Moss]]");
  expect(cy).toMatch(/\[\[people\/ana-diaz\|Ana Diaz\]\]\.\[\^pf?-[a-z-]+\]/);
  expect(cy).not.toContain("Eve Park");
  expect(ana).not.toContain("Eve Park");
});

// Phone check, 2026-10-26 11:55Z: no org page got its "who works here" line (the people's org
// facts said the org's name in plain words, and the org page opened with an import's line the
// writer keeps), and a summary showed a raw "[^1]".
test("page writer: an org named in plain words lists its people, under text someone else wrote", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `---\nid: orgs/north-college\ntype: org\ntitle: North College\nsummary: "A college, from your notes.[^1]"\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: import\n---\nImported from your notes.[^1]\n\n[^1]: Your notes, 2026-09-01\n`);
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: import");
  person(root, "ana-diaz", "Ana Diaz", fact("org", "North College", "gmail:f0000000000000a1"));
  person(root, "ben-okafor", "Ben Okafor", fact("org", "north college", "gmail:f0000000000000b1"));
  const r = renderTouchedPages(root, SINCE);
  expect(body(root, "people/ana-diaz")).toContain("Ana Diaz works at [[orgs/north-college|North College]].");
  const org = body(root, "orgs/north-college");
  // The import's one line is kept word for word, under the page's own text (phone check 13:08Z).
  expect(org).toStartWith("Imported from your notes.[^1]\n\n## From its facts\n[[people/ana-diaz|Ana Diaz]] and [[people/ben-okafor|Ben Okafor]] work at North College.");
  expect(org).toMatch(/^\[\^1\]: Your notes, 2026-09-01$/m);
  expect(org).toMatch(/^\[\^pf?-[a-z-]+\]: Email, 2026-10-05 \(gmail:f0000000000000b1\)$/m);
  // A second run changes nothing.
  const head = sh(root, "hub", "rev-parse", "HEAD");
  renderTouchedPages(root, SINCE);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(head);
  // The summary under the title reads as words.
  const { notePage } = await import("../src/dashboard/html-brain");
  const { loadState } = await import("../src/dashboard/data");
  const { loadBrain } = await import("../src/brain");
  const html = notePage(loadState(root), "x", loadBrain(root).find((n) => n.fm.id === "orgs/north-college")!, "").body;
  expect(html).toContain('<p class="b-summary">A college, from your notes.</p>');
});

test("page writer: a From its facts section someone edited is theirs, and kept", () => {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `---\nid: orgs/north-college\ntype: org\ntitle: North College\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: import\n---\nImported from your notes.\n\n## From its facts\nSee the alumni list.\n`);
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: import");
  person(root, "ana-diaz", "Ana Diaz", fact("org", "North College", "gmail:f0000000000000a1"));
  renderTouchedPages(root, SINCE);
  const org = body(root, "orgs/north-college");
  expect(org).toContain("## From its facts\nSee the alumni list.");
  expect(org).toContain("## Earlier notes\nImported from your notes.");
  expect(org).not.toMatch(/From its facts\n[^\n]*Ana Diaz/);
});

// Outside review v3, 2026-10-26: the writer special-cased five attributes and wrote the rest as
// "Label of Title: value.", its text wasn't marked as generated where a reader sees it, and its
// Why ("their facts changed") was false for 20 of 30 pages.
test("page writer: any attribute reads as a sentence; the text says the hub wrote it; the Why is true of each page", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("hobby", "sailing", "gmail:f0000000000000a1") + fact("languages", "[French, Portuguese]", "gmail:f0000000000000a1") + fact("last_contact", "2026-10-05", "gmail:f0000000000000a1") + fact("bio", "\"Runs the evening programme; started the alumni mentoring scheme in 2019 and still chairs it\"", "gmail:f0000000000000a1"));
  const r = renderTouchedPages(root, SINCE);
  const ana = body(root, "people/ana-diaz");
  expect(ana).toContain("Ana Diaz's hobby is sailing.");
  // The full name once, then the first name; a date this year without its year (G559).
  expect(ana).toContain("Ana's languages are French and Portuguese.");
  expect(ana).toContain("You were last in touch with Ana on 5 Oct.");
  expect(ana).toContain("On Ana, the bio: Runs the evening programme;");
  expect(ana).not.toMatch(/\b[A-Z][a-z]+ of Ana( Diaz)?: /);
  expect(ana.split("\n\n")[1]).toBe("(Written by the hub from this page's facts.)");
  expect(sh(root, "hub", "log", "-1", "--format=%B")).toMatch(/^Why: \d+ pages are new since 2000-01-01/m);
  expect(r.written).toContain("people/ana-diaz");
  // A page whose facts didn't change since `since`, only its text: the Why says so.
  const cut = new Date(Date.now() + 1000).toISOString();
  Bun.sleepSync(1100);
  writeFileSync(join(root, "people", "ana-diaz.md"), readFileSync(join(root, "people", "ana-diaz.md"), "utf8").replace("\n\n(Written by the hub from this page's facts.)", ""));
  sh(root, "hub", "commit", "-qam", "hub: text");
  renderTouchedPages(root, cut);
  expect(sh(root, "hub", "log", "-1", "--format=%B")).toMatch(/^Why: 1 page changed only in its links or text since /m);
});

// Review thread, 2026-10-26: a page opening with an import line and holding facts of its own got
// only link lines; every touched page gets cited prose, under the text someone else wrote.
test("page writer: a page opening with someone else's text gets its facts' cited sentences beneath it", () => {
  const root = makeBrain();
  writeFileSync(join(root, "people", "ana-diaz.md"), `---\nid: people/ana-diaz\ntype: person\ntitle: Ana Diaz\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: import\n---\nImported from your notes.[^1]\n\n[^1]: Your notes, 2026-09-01\n`);
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: import");
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  writeFileSync(join(root, "people", "ana-diaz.md"), readFileSync(join(root, "people", "ana-diaz.md"), "utf8") + "Imported from your notes.[^1]\n\n[^1]: Your notes, 2026-09-01\n");
  sh(root, "louis", "commit", "-qam", "owner: keep the import line");
  const r = renderTouchedPages(root, SINCE);
  expect(r.written).toContain("people/ana-diaz");
  const b = body(root, "people/ana-diaz");
  expect(b).toStartWith("Imported from your notes.[^1]\n\n## From its facts\nAna Diaz's role is program director.[^pf-role]\n\n(Written by the hub from this page's facts.)");
  expect(b).toMatch(/^\[\^1\]: Your notes, 2026-09-01$/m);
  expect(b).toMatch(/^\[\^pf-role\]: Email, 2026-10-05 \(gmail:f0000000000000a1\)$/m);
});

test("page writer: a longer text in the owner's commit stays on top, the facts' sentences beneath it (G682)", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "coach tennis", "gmail:f0000000000000a1") + fact("org", "North College", "notion:import/2026-09-15") + fact("hobby", "sailing", "unverified"));
  writeFileSync(join(root, "people", "ana-diaz.md"), readFileSync(join(root, "people", "ana-diaz.md"), "utf8") + "Met Ana at the spring retreat; she runs the evening programme and mentors two of the new lecturers.\nShe prefers calls to email.\n");
  sh(root, "louis", "commit", "-qam", "owner: notes");
  const r = renderTouchedPages(root, SINCE);
  expect(r.kept).toContain("people/ana-diaz");
  const b = body(root, "people/ana-diaz");
  expect(b).toStartWith("Met Ana at the spring retreat;");
  expect(b).toContain("## From its facts\nAna Diaz works as coach tennis at North College.");
  // Every reference says what kind of source it is.
  expect(b).toMatch(/^\[\^pf-org\]: Notion import, 2026-10-05 \(notion:import\/2026-09-15\)$/m);
  expect(b).toMatch(/^\[\^pf-hobby\]: No source given, 2026-10-05$/m);
});

test("upkeep takes reference markers out of every summary, whoever wrote it; an assistant's note names the assistant", async () => {
  const { upkeep } = await import("../src/upkeep");
  const root = makeBrain();
  writeFileSync(join(root, "people", "ana-diaz.md"), `---\nid: people/ana-diaz\ntype: person\ntitle: Ana Diaz\nsummary: "Ana Diaz, head of engineering.[^1]"\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: gardener\nfacts:\n${fact("role", "head of engineering", "agent:planner/2026-10-05")}---\n`);
  sh(root, "gardener", "add", "-A"); sh(root, "gardener", "commit", "-qm", "gardener: page");
  upkeep(root);
  const fm = YAML.parse(readFileSync(join(root, "people", "ana-diaz.md"), "utf8").split(/^---$/m)[1]);
  expect(fm.summary).toBe("Ana Diaz, head of engineering.");
  expect(body(root, "people/ana-diaz")).toMatch(/^\[\^pf-role\]: Planner's note, 2026-10-05 \(agent:planner\/2026-10-05\)$/m);
});

// Phone check on the real brain, 2026-10-26 16:2xZ: an org page had the hub's paragraph twice (as
// its opening and under an old "Related" section), a person page with old text kept it on top and
// had the hub's links in both "Related" and "From its facts", and an org fact read "orgs/<slug>".
// A reader sees one hub-written block per page, old text under Earlier notes, never a raw id.
const MADE_LINE = "(Written by the hub from this page's facts.)";
const count = (s: string, x: string) => s.split(x).length - 1;
function org(root: string, slug: string, title: string, text: string, by: string, o: { sensitivity?: string } = {}) {
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", `${slug}.md`), `---\nid: orgs/${slug}\ntype: org\ntitle: ${title}\narea: work\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: ${by}\n---\n${text}`);
  sh(root, by, "add", "-A"); sh(root, by, "commit", "-qm", `${by}: ${slug}`);
}

test("page writer: an org page carries the hub's text once; an old Related section of its own goes", () => {
  const root = makeBrain();
  org(root, "north-college", "North College", `[[people/ana-diaz|Ana Diaz]] works at North College.[^p-in-ana] ${MADE_LINE}\n\n## Related\n[[people/ana-diaz|Ana Diaz]] works at North College.[^p-in-ana] ${MADE_LINE}\n\n[^p-in-ana]: Email, 2026-10-05 (gmail:f0000000000000a1)\n`, "hub");
  person(root, "ana-diaz", "Ana Diaz", fact("org", "North College", "gmail:f0000000000000a1"));
  renderTouchedPages(root, SINCE);
  const b = body(root, "orgs/north-college");
  expect(b).toStartWith("[[people/ana-diaz|Ana Diaz]] works at North College.");
  expect(count(b, MADE_LINE)).toBe(1);
  expect(b).not.toContain("## Related");
});

test("page writer: old text on a person page stays on top; the hub's links are said once (G682)", () => {
  const root = makeBrain();
  person(root, "ben-okafor", "Ben Okafor", fact("role", "senior assistant", "gmail:f0000000000000b1"));
  capture(root, "gmail:f0000000000000a1", ["Ben Okafor"]);
  writeFileSync(join(root, "people", "ana-diaz.md"), `---\nid: people/ana-diaz\ntype: person\ntitle: Ana Diaz\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: gardener\nfacts:\n${fact("role", "program director", "gmail:f0000000000000a1")}---\nAna runs the evening programme at the college and has done since the spring; she mentors two of the new lecturers.[^1]\n\n## Who they are\nThe program director.[^1]\n\n## Related\nIts sources also name [[people/ben-okafor|Ben Okafor]].[^pf-role] ${MADE_LINE}\n\n## From its facts\nAna Diaz's role is program director.[^pf-role] Its sources also name [[people/ben-okafor|Ben Okafor]].[^pf-role] ${MADE_LINE}\n\n[^1]: Email, 2026-10-01 (gmail:f0000000000000a1)\n[^pf-role]: Email, 2026-10-05 (gmail:f0000000000000a1)\n`);
  sh(root, "gardener", "add", "-A"); sh(root, "gardener", "commit", "-qm", "gardener: ana");
  // The two sections as the hub wrote them: last changed by the hub.
  const p = join(root, "people", "ana-diaz.md");
  const full = readFileSync(p, "utf8");
  writeFileSync(p, full.replace(/\n\n## Related[\s\S]*?(?=\n\n\[\^1\])/, ""));
  sh(root, "gardener", "commit", "-qam", "gardener: ana without");
  writeFileSync(p, full);
  sh(root, "hub", "commit", "-qam", "hub: page text for 1 page");
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).toStartWith("Ana runs the evening programme");
  expect(b).toContain("## From its facts\nAna Diaz's role is program director.[^pf-role]");
  expect(b).toContain("## Who they are\nThe program director.[^1]");
  expect(count(b, MADE_LINE)).toBe(1);
  expect(count(b, "Its sources also name")).toBe(1);
  expect(b).not.toContain("## Related");
  expect(count(b, "## From its facts")).toBe(1);
  expect(b).toMatch(/^\[\^1\]: Email, 2026-10-01 \(gmail:f0000000000000a1\)$/m);
});

test("page writer: an org fact naming a page by its id reads as the page's name, in the text and the fact list", async () => {
  const root = makeBrain();
  org(root, "acme-labs", "Acme Labs", "", "planner", { sensitivity: "secret" });
  person(root, "ana-diaz", "Ana Diaz", fact("org", "orgs/acme-labs", "gmail:f0000000000000a1"));
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).not.toContain("orgs/acme-labs");
  expect(b).toContain("Ana Diaz works at Acme Labs.");
  const { notePage } = await import("../src/dashboard/html-brain");
  const { loadState } = await import("../src/dashboard/data");
  const { loadBrain } = await import("../src/brain");
  const html = notePage(loadState(root), "x", loadBrain(root).find((n) => n.fm.id === "people/ana-diaz")!, "").body;
  expect(html).toMatch(/class="b-val"[^>]*>Acme Labs</);
});

// Phone check 2026-10-26 19:4xZ after G445: an old block the owner's commit carried (not text he
// typed) sat under "Your notes" with raw mail ids in it; a relationship said in a section of the
// page was said again in the hub's paragraph.
test("page writer: old text stays on top, never under Your notes; mail ids in it become references (G682)", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  const p = join(root, "people", "ana-diaz.md");
  writeFileSync(p, readFileSync(p, "utf8") + "Ana runs the evening programme (gmail:f0000000000000a1) and mentors two of the new lecturers, see gmail:f0000000000000c9.\n");
  sh(root, "louis", "commit", "-qam", "owner: import notes");
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).not.toContain("## Your notes");
  const earlier = b.split("\n\n")[0] ?? "";
  expect(earlier).toStartWith("Ana runs the evening programme");
  expect(earlier).not.toMatch(/gmail:/);
  expect(b).toMatch(/^\[\^e-[a-z0-9-]+\]: Email, 2026-10-05 \(gmail:f0000000000000a1\)$/m);
  expect(b).toMatch(/^\[\^e-[a-z0-9-]+\]: Email \(gmail:f0000000000000c9\)$/m);
  // A second run changes nothing.
  const head = sh(root, "hub", "rev-parse", "HEAD");
  renderTouchedPages(root, SINCE);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(head);
});

test("page writer: a Your notes section the hub itself moved there becomes Earlier notes", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  const p = join(root, "people", "ana-diaz.md");
  writeFileSync(p, readFileSync(p, "utf8") + `Ana Diaz's role is program director.[^pf-role] (Written by the hub from this page's facts.)\n\n## Your notes\nMet Ana at the spring retreat; she runs the evening programme.\n\n[^pf-role]: Email, 2026-10-05 (gmail:f0000000000000a1)\n`);
  sh(root, "hub", "commit", "-qam", "hub: page text for 1 page");
  writeFileSync(p, readFileSync(p, "utf8").replace("updated: 2026-10-01", "updated: 2026-10-02"));
  sh(root, "planner", "commit", "-qam", "planner: touch");
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).toContain("## Earlier notes\nMet Ana at the spring retreat;");
  expect(b).not.toContain("## Your notes");
});

test("page writer: a fact a section of the page already says isn't said again in the hub's paragraph", () => {
  const root = makeBrain();
  person(root, "cy-moss", "Cy Moss", fact("relationship", "\"Close friend; you connected him with the North College team in 2024\"", "gmail:f0000000000000a1") + fact("role", "program director", "gmail:f0000000000000a1"));
  const p = join(root, "people", "cy-moss.md");
  writeFileSync(p, readFileSync(p, "utf8") + "## Your relationship\nClose friend; you connected him with the North College team in 2024.[^1]\n\n[^1]: Email, 2026-10-05 (gmail:f0000000000000a1)\n");
  sh(root, "gardener", "commit", "-qam", "gardener: cy");
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/cy-moss");
  expect(b).toStartWith("Cy Moss' role is program director.");
  expect(b).not.toContain("How you know Cy Moss");
  expect(count(b, "Close friend; you connected him")).toBe(1);
});

// Mac check 2026-10-26 21:5xZ after G446: 29 pages still showed ids as "Gmail 1a0b…" (the form
// older assistants wrote), in the moved old text and in sections other assistants wrote.
test("page writer: an id written as 'Gmail <id>' in old text becomes a reference too", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:1a0b2c3d4e5f6a7b"));
  const p = join(root, "people", "ana-diaz.md");
  writeFileSync(p, readFileSync(p, "utf8") + "Declined the offer by an email, Gmail 1a0b2c3d4e5f6a7b (Ana to Ken). Her signature in Gmail 99aa88bb77cc66dd (2026-09-18).\n");
  sh(root, "planner", "commit", "-qam", "planner: notes");
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  const earlier = b.split("\n\n")[0] ?? "";
  expect(earlier).toMatch(/^Declined the offer by an email\[\^e-[a-z0-9-]+\] \(Ana to Ken\)\. Her signature in an email\[\^e-[a-z0-9-]+\] \(2026-09-18\)\.$/);
  expect(b).toMatch(/^\[\^e-[a-z0-9-]+\]: Email, 2026-10-05 \(gmail:1a0b2c3d4e5f6a7b\)$/m);
  expect(b).toMatch(/^\[\^e-[a-z0-9-]+\]: Email \(gmail:99aa88bb77cc66dd\)$/m);
});

test("note page and phone page: an id in a section someone else wrote reads as words, never the id", async () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:1a0b2c3d4e5f6a7b"));
  const p = join(root, "people", "ana-diaz.md");
  writeFileSync(p, readFileSync(p, "utf8") + "## Added by Planner (2026-10-04)\nFirewood question: Gmail 1a0b2c3d4e5f6a7b (2026-09-22). Also see gmail:99aa88bb77cc66dd. Kit decline: 0f1e2d3c4b5a6978, email thread 1122334455667788.\n");
  sh(root, "planner", "commit", "-qam", "planner: notes");
  const { notePage } = await import("../src/dashboard/html-brain");
  const { ownerPage } = await import("../src/dashboard/html-page");
  const { loadState } = await import("../src/dashboard/data");
  const { loadBrain } = await import("../src/brain");
  const n = loadBrain(root).find((x) => x.fm.id === "people/ana-diaz")!;
  const note = notePage(loadState(root), "x", n, "").body;
  const phone = ownerPage(loadState(root), "x", n, []);
  for (const html of [note, phone]) {
    // What a reader sees: the edit boxes hold the file's own text, ids and all.
    const text = html.replace(/<(textarea|script)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ");
    expect(text).toContain("Firewood question: an email (2026-09-22).");
    expect(text).toContain("Kit decline: an email, email thread.");
    expect(text).not.toMatch(/1a0b2c3d4e5f6a7b|99aa88bb77cc66dd|0f1e2d3c4b5a6978|1122334455667788/);
  }
});

// UI thread, Mac clone check 2026-10-27: an Undo that left a page with no live fact kept the hub's
// old opening, still saying the undone value, until something else rewrote the page. With nothing
// left to say, the writer takes its own opening and its references out; everything else stays.
test("page writer: a page left with no fact loses the hub's opening, keeps the rest", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000a1"));
  renderTouchedPages(root, SINCE);
  const p = join(root, "people", "ana-diaz.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(/(\n\[\^pf-role\]:)/, "\n## Notes\nMet at the fair.\n$1"));
  sh(root, "louis", "commit", "-qam", "louis: notes");
  writeFileSync(p, readFileSync(p, "utf8").replace(/facts:\n  role:\n(?:    [^\n]*\n|      [^\n]*\n)+/, ""));
  sh(root, "louis", "commit", "-qam", "undo: role");
  const r = renderTouchedPages(root, SINCE);
  expect(r.written).toContain("people/ana-diaz");
  const b = body(root, "people/ana-diaz");
  expect(b).not.toContain("program director");
  expect(b).not.toContain("Written by the hub");
  expect(b).not.toMatch(/\[\^pf-/);
  expect(b).toContain("## Notes\nMet at the fair.");
});

// Outside review v5, midday: 25 pages (decisions, money, orgs) had the hub's cited lead and nothing
// linking to them. A page whose facts link another gets a link back ("See also"), cited by those
// facts' sources. The owner's own page lists no other pages (G624, owner 2026-11-01: his page glued
// unrelated mail together).
test("a page a fact links to links back; the owner's page lists no unlinked pages", () => {
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  writeFileSync(join(root, "people", "robin-vale.md"), `---\nid: people/robin-vale\ntype: person\ntitle: Robin Vale\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  city: { value: Halifax, as_of: 2026-10-05, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n---\n`);
  const a = join(root, "projects", "course-a.md");
  writeFileSync(a, readFileSync(a, "utf8").replace(/^facts:\n/m, `facts:\n  advisor: { value: "[[people/paul-advisor]]", as_of: 2026-10-05, sources: ["gmail:f000000000000008"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n`));
  const dec = join(root, "decisions", "2026-09-01-pick-bank.md");
  writeFileSync(dec, readFileSync(dec, "utf8").replace("by: steward\n---", "by: steward\nfacts:\n  chosen: { value: Maple Trust Bank, as_of: 2026-09-01, sources: [\"gmail:f000000000000007\"], verification: verified-by-source, by: steward, recorded: 2026-09-01 }\n---"));
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: setup");
  renderTouchedPages(root, SINCE);
  const paul = body(root, "people/paul-advisor");
  expect(paul).toMatch(/See also \[\[projects\/course-a\|[^\]]+\]\]\.\[\^p-see-course-a\]/);
  expect(paul).toContain("[^p-see-course-a]: ");
  const robin = body(root, "people/robin-vale");
  expect(robin).toContain("Halifax");
  expect(robin).not.toContain("See also");
  expect(robin).not.toContain("[[money/main-bank");
});

// Demo brain, 2026-10-30: a list fact whose items all came from one email cited that email once per
// item ("Email, 2026-09-12 (gmail:…); Email, 2026-09-12 (gmail:…); …" five times).
test("page writer: a list whose items share one source cites it once", () => {
  const root = makeBrain();
  const item = (v: string) => `{ value: ${v}, as_of: 2026-10-05, sources: ["gmail:f0000000000000b1"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
  person(root, "ana-diaz", "Ana Diaz", `  teams:\n    items: [${["Admissions", "Finance", "Research"].map(item).join(", ")}]\n`);
  renderTouchedPages(root, SINCE);
  const b = body(root, "people/ana-diaz");
  expect(b).toMatch(/^\[\^pf-teams\]: Email, 2026-10-05 \(gmail:f0000000000000b1\)$/m);
});
