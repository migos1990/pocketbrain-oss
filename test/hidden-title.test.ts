// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13, 2026-11-09 (slice audit, high; G754, G755, G756): a page a reader can't see had its
// title served to that reader in plain words. A fact that links such a page shows the reader
// `[[redacted]]`, but the page writer wrote the page's name as plain text exactly when some reader
// couldn't see it ("Pat Lee is the founder at Zorblax Holdings."), the Gardener's summary could
// name it, and a model's opening could reword the writer's sentence that named it.
// Now the writer links such a page by its id like any other, so each reader's own read redacts it;
// and on a page whose fact or text links a page out of the reader's view, that page's title, its
// aliases and the words the link used are withheld from the page's text and summary (text written
// before this fix, a summary, an opening). wiki_sync refuses a summary or section that names one.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { loadBrain, saveNote, type Note } from "../src/brain";
import { readNote, search, contextPack, whatsNew, gardenerWikiSync, remember, why } from "../src/core";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const SINCE = "2000-01-01T00:00:00Z";
const fact = (value: string, mail: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:${mail}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
const head = (id: string, type: string, title: string, o: { area?: string; sensitivity?: string; aliases?: string[] } = {}) => `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\n${o.aliases ? `aliases: [${o.aliases.join(", ")}]\n` : ""}area: ${o.area ?? "work"}\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
const NAME = "Zorblax Holdings";
type Hide = "private" | "exclude" | "area";

// Pat Lee's org and Course A's partner link Zorblax Holdings, which `helper` can't see: a private
// page, a page the owner hid from it by name, or a page outside its areas.
function brain(hide: Hide, o: { link?: string; render?: boolean } = {}) {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(policy, "utf8"));
  if (hide === "exclude") p.agents.helper.exclude = ["projects/zorblax-holdings"];
  p.wiki = { ...(p.wiki ?? {}), sync: true, opening: true };
  writeFileSync(policy, YAML.stringify(p));
  mkdirSync(join(root, "projects"), { recursive: true });
  const link = o.link ?? "[[projects/zorblax-holdings]]";
  writeFileSync(join(root, "projects", "zorblax-holdings.md"), `${head("projects/zorblax-holdings", "project", NAME, { aliases: ["ZH Group"], sensitivity: hide === "private" ? "private" : "personal", area: hide === "area" ? "personal" : "work" })}facts:\n  status: ${fact("active", "f0000000000000c0")}\n---\n`);
  writeFileSync(join(root, "people", "pat-lee.md"), `${head("people/pat-lee", "person", "Pat Lee")}facts:\n  role: ${fact("founder", "f0000000000000c1")}\n  org: ${fact(link, "f0000000000000c1")}\n---\n`);
  writeFileSync(join(root, "projects", "course-a.md"), `${head("projects/course-a", "project", "Course A")}facts:\n  partner: ${fact(link, "f0000000000000c2")}\n  status: ${fact("active", "f0000000000000c2")}\n---\n`);
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: zorblax, pat and course a");
  if (o.render !== false) renderTouchedPages(root, SINCE);
  return root;
}
const edit = (root: string, id: string, f: (n: Note) => void) => {
  const n = loadBrain(root).find((x) => x.fm.id === id)!;
  f(n);
  saveNote(root, n);
  sh(root, "louis", "commit", "-qam", `owner: ${id}`);
};
// Everything `agent` is handed about the two pages, on each read path.
async function served(root: string, agent: string): Promise<string> {
  const out: unknown[] = [];
  for (const id of ["people/pat-lee", "projects/course-a"]) out.push(readNote(root, agent, id));
  out.push(search(root, agent, "Pat Lee founder"), search(root, agent, "Course A partner"));
  out.push(contextPack(root, agent, "Pat Lee"), contextPack(root, agent, "Course A"));
  out.push(whatsNew(root, agent, "1990-01-01"));
  return JSON.stringify(out);
}

for (const hide of ["private", "exclude", "area"] as Hide[]) {
  test(`G754 the page writer never tells a reader the name of a page it can't see (${hide})`, async () => {
    const root = brain(hide);
    const got = await served(root, "helper");
    expect(got).toContain("Pat Lee");
    expect(got).not.toContain(NAME);
    expect(got).not.toMatch(/zorblax/i);
    // A reader who sees the page still reads its name, as a link.
    const pat = (readNote(root, "steward", "people/pat-lee") as { body: string }).body;
    expect(pat).toContain(`[[projects/zorblax-holdings|${NAME}]]`);
  });

  test(`G754 a link by title or alias, with its own words, or a bare id as the value is no different (${hide})`, async () => {
    for (const link of [`[[${NAME}]]`, "[[projects/zorblax-holdings|the Zorblax people]]", "[[ZH Group]]", "projects/zorblax-holdings"]) {
      const got = await served(brain(hide, { link }), "helper");
      expect(got).not.toMatch(/zorblax/i);
      expect(got).not.toContain("ZH Group");
    }
  });

  test(`G754 text written before this fix, naming the page in plain words, is withheld on a read (${hide})`, async () => {
    const root = brain(hide, { render: false });
    edit(root, "people/pat-lee", (n) => { n.body = `Pat Lee is the founder at ${NAME}.[^pf-role][^pf-org]\n\n(Written by the hub from this page's facts.)\n\n[^pf-role]: Email, 2026-10-05 (gmail:f0000000000000c1)\n[^pf-org]: Email, 2026-10-05 (gmail:f0000000000000c1)\n`; });
    const got = await served(root, "helper");
    expect(got).toContain("Pat Lee");
    expect(got).not.toMatch(/zorblax/i);
    expect((readNote(root, "steward", "people/pat-lee") as { body: string }).body).toContain(NAME);
  });

  test(`G755 a summary that names the page is withheld from that reader, and wiki_sync refuses a new one (${hide})`, async () => {
    const root = brain(hide);
    // The Gardener sees the page; helper, who reads Pat's page, doesn't. Nothing is saved.
    const was = process.env.PB_NOW;
    process.env.PB_NOW = "2026-10-08T07:30:00Z";
    try {
      expect(() => gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: `Pat Lee founded ${NAME}.` })).toThrow(/names a page that someone who reads this page can't see/);
      expect(() => gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: "Pat Lee founded the ZH Group." })).toThrow(/hidden from someone who reads this page|names a page that someone who reads this page can't see/);
      expect((gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: "Pat Lee is a founder." }) as { applied: boolean }).applied).toBe(true);
    } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
    expect(loadBrain(root).find((n) => n.fm.id === "people/pat-lee")!.fm.summary).toBe("Pat Lee is a founder.");
    // A summary from before this fix, or one a person wrote: withheld from the reader who can't see the page.
    edit(root, "people/pat-lee", (n) => { n.fm.summary = `Pat Lee is the founder at ${NAME}.`; });
    const got = await served(root, "helper");
    expect(got).not.toMatch(/zorblax/i);
    expect(JSON.stringify(readNote(root, "steward", "people/pat-lee"))).toContain(`founder at ${NAME}`);
  });

  test(`G756 a model's opening that names the page never lands (${hide})`, () => {
    const root = brain(hide);
    edit(root, "projects/course-a", () => {});
    const was = process.env.PB_NOW;
    process.env.PB_NOW = "2026-10-08T07:30:00Z";
    try {
      expect(() => gardenerWikiSync(root, "gardener", { id: "projects/course-a", opening: { text: `Course A is active with ${NAME} as its partner.`, labels: ["pf-partner", "pf-status"] } })).toThrow(/opening/);
    } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
    expect(loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.opening).toBeUndefined();
  });
}

test("G756 an opening saved before this fix that names the page is not served to that reader", async () => {
  const root = brain("area");
  edit(root, "projects/course-a", (n) => { n.fm.opening = { text: `Course A is active with ${NAME} as its partner.`, labels: ["pf-partner", "pf-status"], by: "gardener", on: "2026-10-07" }; });
  renderTouchedPages(root, SINCE);
  expect(await served(root, "helper")).not.toMatch(/zorblax/i);
});

test("a page every reader sees is still named, and linked", async () => {
  const root = brain("area");
  edit(root, "projects/zorblax-holdings", (n) => { n.fm.area = "work"; });
  renderTouchedPages(root, SINCE);
  const pat = (readNote(root, "helper", "people/pat-lee") as { body: string }).body;
  expect(pat).toContain(`[[projects/zorblax-holdings|${NAME}]]`);
});

// ---- Slice audit of this fix (2026-11-09): what the first cut left open. ----
const sync = <T>(f: () => T): T => { const was = process.env.PB_NOW; process.env.PB_NOW = "2026-10-08T07:30:00Z"; try { return f(); } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; } };
const refusal = (f: () => unknown) => { try { f(); return "applied"; } catch (e) { return (e as Error).message.replace(/"[^"]*"/g, '"…"'); } };

test("slice audit: the Gardener's guess at a page hidden from it too answers like any other name", () => {
  const root = brain("area");
  const policy = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(policy, "utf8"));
  p.agents.gardener.exclude = ["projects/zorblax-holdings"];
  writeFileSync(policy, YAML.stringify(p));
  sh(root, "louis", "commit", "-qam", "owner: hide it from the gardener too");
  const hit = sync(() => refusal(() => gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: `Pat Lee founded ${NAME}.` })));
  const miss = sync(() => refusal(() => gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: "Pat Lee founded Quuxcorp Holdings." })));
  expect(hit).not.toBe("applied");
  expect(hit).toBe(miss);
});

for (const hide of ["private", "exclude", "area"] as Hide[]) {
  test(`slice audit: a writer's link to a hidden page and to no page read the same in the page's text (${hide})`, () => {
    const body = (value: string) => {
      const root = brain(hide);
      // planner reads Course A; Zorblax is out of its view only in two of the modes, helper's in all three.
      const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
      n.fm.facts!.sponsor = { value, as_of: "2026-10-07", sources: ["gmail:f0000000000000c2"], verification: "verified-by-source", by: "planner", recorded: "2026-10-07" } as never;
      saveNote(root, n); sh(root, "planner", "commit", "-qam", "planner: sponsor");
      renderTouchedPages(root, SINCE);
      const r = readNote(root, "helper", "projects/course-a") as { body: string };
      return (r.body.match(/[^.\n]*sponsor[^.\n]*/i) ?? [""])[0];
    };
    expect(body(`[[${NAME}]]`)).toBe(body("[[Guess Corp]]"));
    expect(body("[[ZH Group]]")).toBe(body("[[Guess Corp]]"));
    expect(body("projects/zorblax-holdings")).toBe(body("projects/guess-corp"));
    expect(body("[[Guess Corp]]")).toContain("[[redacted]]");
  });

  test(`slice audit: a short form of the hidden page's name is refused in a summary and withheld on a read (${hide})`, async () => {
    const root = brain(hide);
    expect(sync(() => refusal(() => gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: "Pat Lee founded Zorblax." })))).toMatch(/names a page that someone who reads this page can't see/);
    edit(root, "people/pat-lee", (n) => { n.fm.summary = "Pat Lee founded Zorblax."; n.body = `${n.body}\n\n## Your notes\n\nMet the Zorblax group in May (Zorblax).\n`; });
    const got = await served(root, "helper");
    expect(got).not.toMatch(/zorblax/i);
    expect(JSON.stringify(readNote(root, "steward", "people/pat-lee"))).toContain("Zorblax group");
  });

  test(`slice audit: a reference label spelling the hidden page's name is withheld (${hide})`, async () => {
    const root = brain(hide);
    edit(root, "people/pat-lee", (n) => { n.body = `${n.body}\n\nPat signed in May.[^zorblax-holdings] And again.[^p-rel-zorblax]\n\n[^zorblax-holdings]: Email, 2026-10-05 (gmail:f0000000000000c1)\n[^p-rel-zorblax]: Email, 2026-10-05 (gmail:f0000000000000c1)\n`; });
    expect(await served(root, "helper")).not.toMatch(/zorblax/i);
  });
}

test("slice audit: a word the hidden page shares with a page in view stays", () => {
  const root = brain("area");
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "maple-holdings.md"), `${head("orgs/maple-holdings", "org", "Maple Holdings")}---\n`);
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: maple holdings");
  edit(root, "people/pat-lee", (n) => { n.body = `${n.body}\n\n## Your notes\n\nPat also advises Maple Holdings.\n`; });
  expect((readNote(root, "helper", "people/pat-lee") as { body: string }).body).toContain("Pat also advises Maple Holdings.");
});

test("slice audit: a carved value inside a reference label still withholds its line", () => {
  const root = brain("area");
  // money/main-bank holds "Maple Trust Bank", out of helper's view.
  edit(root, "people/pat-lee", (n) => { n.body = `${n.body}\n\nPaid in May.[^maple-trust-bank]\n\n[^maple-trust-bank]: Email, 2026-10-05 (gmail:f0000000000000c1)\n`; });
  expect(JSON.stringify(readNote(root, "helper", "people/pat-lee")).toLowerCase()).not.toContain("maple-trust-bank");
});

// Second slice audit of G754 (2026-11-09).
test("G754 a person's org in plain words that is a hidden org page's title reads like one that names no page", () => {
  const body = (title: string) => {
    const root = makeBrain();
    mkdirSync(join(root, "orgs"), { recursive: true });
    writeFileSync(join(root, "orgs", "vexmoor.md"), `${head("orgs/vexmoor", "org", "Vexmoor Partners", { sensitivity: "private" })}---\n`);
    writeFileSync(join(root, "people", "sam-roe.md"), `${head("people/sam-roe", "person", "Sam Roe")}facts:\n  org: ${fact(title, "f0000000000000c4")}\n---\n`);
    sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", "owner: sam");
    renderTouchedPages(root, SINCE);
    return (readNote(root, "helper", "people/sam-roe") as { body: string }).body;
  };
  const hit = body("Vexmoor Partners"), miss = body("Guessmoor Partners");
  expect(miss).toContain("Sam Roe works at Guessmoor Partners.");
  expect(hit).toBe(miss.replaceAll("Guessmoor", "Vexmoor"));
});

test("G754 a reader's own write of a word of the hidden name doesn't unmask its short form", () => {
  const root = brain("area", { render: false });
  edit(root, "people/pat-lee", (n) => { n.body = "Met the Zorblax group in May.\n"; });
  const read = () => (readNote(root, "planner", "people/pat-lee") as { body: string }).body;
  // planner reads work only: Zorblax Holdings (personal area) is out of its view.
  expect(read()).not.toMatch(/zorblax/i);
  const r = remember(root, "planner", { id: "projects/course-a", attribute: "keywords", value: "alpha quuxcorp zorblax vexmoor beta", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  expect(read()).not.toMatch(/zorblax/i);
});

test("G754 an id-shaped value in another case reads the same whether or not it is a page", () => {
  const body = (v: string) => (readNote(brain("area", { link: v }), "helper", "people/pat-lee") as { body: string }).body;
  expect(body("Projects/zorblax-holdings")).toBe(body("Projects/guess-corp"));
});

test("G754 a writer's word list on a page that links a hidden page reads back as written, hit or miss", () => {
  const root = brain("area");
  const r = remember(root, "planner", { id: "people/pat-lee", attribute: "nickname", value: "alpha quuxcorp zorblax vexmoor holdings beta", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  renderTouchedPages(root, SINCE);
  const b = (readNote(root, "planner", "people/pat-lee") as { body: string }).body;
  expect(b).toContain("alpha quuxcorp zorblax vexmoor holdings beta");
  // Another reader granted that fact reads the hub's sentence as it reads the fact: as written.
  const h = readNote(root, "helper", "people/pat-lee") as { body: string; facts: Record<string, { value: string }> };
  expect(h.body).toContain(h.facts.nickname!.value);
});

// Third slice-audit round, settled after the security review: a page's facts and the hub's sentence
// that prints them read the same to a reader. The name whole is withheld in both; a single word a
// granted fact shares with the name ("Course coordinator" beside a hidden "Course A") is that
// fact's own and reads as written in both, so the two never differ.
test("G754 a fact's value and the hub's sentence for it read the same: the whole name withheld, a shared word kept", async () => {
  const root = brain("area", { render: false });
  const rec = (value: string) => ({ value, as_of: "2026-10-05", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by: "steward", recorded: "2026-10-05" }) as never;
  edit(root, "people/pat-lee", (n) => { n.fm.facts!.about = rec("runs Zorblax Holdings day to day with Quuxcorp"); n.fm.facts!.nickname = rec("the Zorblax one"); });
  renderTouchedPages(root, SINCE);
  const got = await served(root, "helper");
  expect(got).not.toMatch(/zorblax holdings/i);
  expect(got).toContain("Quuxcorp");
  const r = readNote(root, "helper", "people/pat-lee") as { body: string; facts: Record<string, { value: string }> };
  expect(r.facts.about!.value).toBe("runs [withheld] day to day with Quuxcorp");
  expect(r.body).toContain("runs [withheld] day to day with Quuxcorp");
  expect(r.facts.nickname!.value).toBe("the Zorblax one");
  expect(r.body).toContain("the Zorblax one");
  // steward sees the page it names: as written.
  expect((readNote(root, "steward", "people/pat-lee") as { facts: Record<string, { value: string }> }).facts.about!.value).toContain("Zorblax Holdings");
});

test("G754 only the reader's own value in the hub's own sentence reads as written, never text beside it", () => {
  const root = brain("area");
  expect(remember(root, "planner", { id: "people/pat-lee", attribute: "nickname", value: "alpha", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" }).outcome).toBe("committed");
  renderTouchedPages(root, SINCE);
  edit(root, "people/pat-lee", (n) => {
    // A person's words in front of the hub's sentence, and a person's sentence citing the reader's label.
    n.body = n.body.replace("Pat's nickname is alpha.", `Pat met ${NAME} in May. Pat's nickname is alpha.`) + `\n## Your notes\n\nPat Lee founded ${NAME} in 2019.[^pf-nickname]\n`;
  });
  const b = (readNote(root, "planner", "people/pat-lee") as { body: string }).body;
  expect(b).toContain("nickname is alpha.");
  expect(b).not.toMatch(/zorblax/i);
});

test("G754 why and the today pack withhold a hidden name in a fact's value, as a read does", () => {
  const root = brain("area", { render: false });
  const rec = (value: string) => ({ value, as_of: "2026-10-07", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by: "steward", recorded: "2026-10-07" }) as never;
  edit(root, "people/pat-lee", (n) => { n.fm.facts!.about = rec("runs Zorblax Holdings day to day with Quuxcorp"); n.fm.facts!.next_step = rec("call Zorblax Holdings about Quuxcorp"); });
  expect(JSON.stringify(why(root, "helper", "people/pat-lee#about"))).toContain("runs [withheld] day to day");
  expect(JSON.stringify(why(root, "helper", "people/pat-lee#about"))).not.toMatch(/zorblax/i);
  const pack = JSON.stringify(whatsNew(root, "helper", "1990-01-01")) + contextPack(root, "helper", "what is next today?");
  expect(pack).not.toMatch(/zorblax/i);
});

// Fifth slice-audit round: a list several assistants wrote. The writer's own item read as written
// in the fact but withheld in the page's sentence (and in why), so the two differed on a hit only.
test("G754 a writer's item in a list others also wrote reads the same in fact, text and why, hit or miss", () => {
  const item = (by: string, value: string) => ({ value, as_of: "2026-10-06", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by, recorded: "2026-10-06" }) as never;
  const run = (w: string) => {
    const root = brain("area");
    edit(root, "people/pat-lee", (n) => { (n.fm.facts as Record<string, unknown>).tags = { items: [item("steward", `beta ${w}`), item("planner", `alpha ${w} gamma`), item("steward", "delta")] }; });
    renderTouchedPages(root, SINCE);
    const r = readNote(root, "planner", "people/pat-lee") as { body: string; facts: Record<string, unknown> };
    return { fact: JSON.stringify(r.facts.tags), body: r.body, why: JSON.stringify(why(root, "planner", "people/pat-lee#tags")), helper: JSON.stringify(readNote(root, "helper", "people/pat-lee")) };
  };
  const hit = run("Zorblax Holdings"), miss = run("Quuxcorp Partners");
  // Its own item as written, everywhere; the other writer's item withheld everywhere.
  for (const x of [hit.fact, hit.body, hit.why]) { expect(x).toContain("alpha Zorblax Holdings gamma"); expect(x).not.toContain("beta Zorblax"); expect(x).toContain("beta [withheld]"); }
  for (const x of [miss.fact, miss.body, miss.why]) { expect(x).toContain("alpha Quuxcorp Partners gamma"); expect(x).toContain("beta Quuxcorp Partners"); }
  // A reader who wrote none of it gets no word of the name.
  expect(hit.helper).not.toMatch(/zorblax/i);
});

// Sixth slice-audit round: the commonest sentence joins the reader's own fact to another writer's
// ("is the <role> at <org>"), and the hub rewrites some values (a dated next step), so the value
// as stored isn't in the sentence. The reader's own words still read as written, hit or miss.
test("G754 a writer's role beside another's hidden org, and a dated next step, read the same hit or miss", () => {
  const run = (w: string) => {
    const root = brain("area");
    edit(root, "people/pat-lee", (n) => { (n.fm.facts!.org as { by: string }).by = "steward"; });
    for (const [attribute, value] of [["role", `alpha ${w} lead`], ["next_step", `2026-10-20 call ${w} again`]] as const)
      expect(remember(root, "planner", { id: "people/pat-lee", attribute, value, as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" }).outcome).toBe("committed");
    renderTouchedPages(root, SINCE);
    return { body: (readNote(root, "planner", "people/pat-lee") as { body: string }).body, helper: JSON.stringify(readNote(root, "helper", "people/pat-lee")) };
  };
  // (The exact title as the writer's own role is a ceiling row: the hub links it.)
  for (const [h, m] of [["zorblax", "quuxcorp"]] as const) {
    const hit = run(h), miss = run(m);
    expect(hit.body).toContain(`alpha ${h} lead`);
    expect(hit.body).toContain(`call ${h} again`);
    expect(hit.body.replaceAll(h, m)).toBe(miss.body);
    // A reader who wrote none of it never gets the name whole.
    expect(hit.helper).not.toMatch(/zorblax holdings/i);
  }
});

// Seventh round: the hub cites another writer's fact in a sentence without printing its value,
// and the reader's own value holds that value's words: they are the reader's, not walked past.
test("G754 a writer's role that contains another writer's plain-words org reads the same hit or miss", () => {
  const run = (w: string) => {
    const root = brain("area");
    edit(root, "people/pat-lee", (n) => { const f = n.fm.facts as Record<string, { by: string; value: unknown }>; f.partner = { ...f.org!, by: "steward" }; f.org = { ...f.org!, by: "steward", value: "Acme" }; f.role!.by = "steward"; });
    expect(remember(root, "planner", { id: "people/pat-lee", attribute: "role", value: `Acme ${w} lead`, as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" }).outcome).toBe("committed");
    renderTouchedPages(root, SINCE);
    return (readNote(root, "planner", "people/pat-lee") as { body: string }).body;
  };
  const hit = run("zorblax"), miss = run("quuxcorp");
  expect(hit).toContain("Acme zorblax lead");
  expect(hit.replace(/zorblax/g, "quuxcorp")).toBe(miss);
});

// Security review of the set-aside: it took the reader's own value wherever its letters stood, so
// an ended list item "or" (cited, never printed) or a fact whose label collides with another's
// ("met_at", "met__at") split another writer's plain-words name and unmasked it letter by letter.
test("G754 a reader's own short value never unmasks another writer's words", () => {
  const rec = (by: string, value: string, more: Record<string, string> = {}) => ({ value, as_of: "2026-10-06", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by, recorded: "2026-10-06", ...more }) as never;
  const body = (f: (facts: Record<string, unknown>) => void) => {
    const root = brain("area");
    edit(root, "people/pat-lee", (n) => f(n.fm.facts as Record<string, unknown>));
    renderTouchedPages(root, SINCE);
    return (readNote(root, "planner", "people/pat-lee") as { body: string }).body;
  };
  const ended = body((facts) => { facts.events = { items: [rec("steward", "Zorblax Holdings offsite in May"), rec("planner", "or", { valid_to: "2026-10-07" }), rec("planner", "ol", { valid_to: "2026-10-07" })] }; });
  expect(ended).not.toMatch(/zorblax|holdings/i);
  const live = body((facts) => { facts.events = { items: [rec("steward", "Zorblax Holdings offsite in May"), rec("planner", "or"), rec("planner", "ol")] }; });
  expect(live).not.toMatch(/zorblax|holdings/i);
  // A whole-word guess: an own record the hub doesn't print (more private than the page), and an
  // own org the hub folds into another writer's role sentence without printing it.
  const priv = body((facts) => { facts.events = { items: [rec("steward", "Zorblax Holdings offsite in May"), rec("planner", "Zorblax", { sensitivity: "private" }), rec("planner", "Holdings", { sensitivity: "private" })] }; });
  expect(priv).not.toMatch(/zorblax|holdings/i);
  const fold = body((facts) => { facts.partner = facts.org; facts.role = rec("steward", "lead of Zorblax Holdings board"); facts.org = rec("planner", "Zorblax"); });
  expect(fold).not.toMatch(/of zorblax|holdings/i);
  const clash = body((facts) => { facts.met_at = rec("steward", "Zorblax Holdings offsite in May"); facts.met__at = rec("planner", "or ol"); });
  expect(clash).not.toMatch(/zorblax|holdings/i);
});

// Last slice-audit round: a word of the hidden name that a granted fact on the page shows reads
// the same in that page's summary and notes, so the two never tell a reader it is a name's word.
test("G754 a word a granted fact on the page shows is not withheld in that page's summary or notes", () => {
  const root = brain("area", { render: false });
  edit(root, "people/pat-lee", (n) => {
    n.fm.facts!.about = { value: "runs Zorblax day to day", as_of: "2026-10-05", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by: "steward", recorded: "2026-10-05" } as never;
    n.fm.summary = "Pat Lee runs Zorblax day to day, for Zorblax Holdings.";
    n.body = "Pat likes the Zorblax office.\n";
  });
  for (const agent of ["helper", "planner"]) {
    const r = readNote(root, agent, "people/pat-lee") as { body: string; summary?: string; facts: Record<string, { value: string }> };
    expect(r.facts.about!.value).toBe("runs Zorblax day to day");
    expect(JSON.stringify(r)).toContain("Pat Lee runs Zorblax day to day, for [withheld].");
    expect(r.body).toContain("Pat likes the Zorblax office.");
  }
  // With no fact showing the word, the same prose still loses it.
  edit(root, "people/pat-lee", (n) => { delete n.fm.facts!.about; });
  expect((readNote(root, "helper", "people/pat-lee") as { body: string }).body).toContain("Pat likes the [withheld] office.");
});

test("G754 a fact that holds the hidden page's whole name or alias leaves its words withheld in the page's prose", () => {
  const root = brain("area", { render: false });
  const rec = (value: string) => ({ value, as_of: "2026-10-05", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by: "steward", recorded: "2026-10-05" }) as never;
  edit(root, "people/pat-lee", (n) => {
    n.fm.facts!.history = rec("joined Zorblax Holdings in 2019"); n.fm.facts!.advises = rec("advises ZH Group");
    n.fm.summary = "Pat Lee runs Zorblax day to day.";
    n.body = "Pat joined Zorblax in 2019. Met the Zorblax group.\n";
  });
  for (const agent of ["helper", "planner"]) {
    const r = readNote(root, agent, "people/pat-lee") as { body: string; facts: Record<string, { value: string }> };
    expect(r.facts.history!.value).toBe("joined [withheld] in 2019");
    expect(JSON.stringify(r)).not.toMatch(/zorblax/i);
    expect(r.body).toContain("Met the [withheld] [withheld].");
  }
  // In another spelling the fact is withheld whole: its words are not shown by it either.
  for (const v of ["see zorblax-holdings dot example", "Zorblax  Holdings rep", "Zorblax, Holdings rep"]) {
    edit(root, "people/pat-lee", (n) => { n.fm.facts!.history = rec(v); });
    expect(JSON.stringify(readNote(root, "helper", "people/pat-lee"))).not.toMatch(/zorblax/i);
  }
});

// Code review of PR 149: the Gardener's facts were one line of JSON when the hidden name was
// withheld from them, so a name in another spelling took every fact with it and an honest summary
// was refused as beyond the facts.
test("G755 a hidden name in another spelling in one fact leaves the page's other facts as ground for a summary", () => {
  const root = brain("exclude");
  const policy = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(policy, "utf8"));
  p.agents.gardener.exclude = ["projects/zorblax-holdings"];
  writeFileSync(policy, YAML.stringify(p));
  sh(root, "louis", "commit", "-qam", "owner: hide it from the gardener too");
  edit(root, "people/pat-lee", (n) => { n.fm.facts!.met = { value: "Met the Zorblax-Holdings team in May", as_of: "2026-10-05", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by: "planner", recorded: "2026-10-05" } as never; n.fm.facts!.team = { value: "Quillon Labs", as_of: "2026-10-05", sources: ["gmail:f0000000000000c1"], verification: "verified-by-source", by: "planner", recorded: "2026-10-05" } as never; });
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-10-08T07:30:00Z";
  try { expect((gardenerWikiSync(root, "gardener", { id: "people/pat-lee", summary: "Pat Lee works with Quillon Labs." }) as { applied: boolean }).applied).toBe(true); }
  finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
});
