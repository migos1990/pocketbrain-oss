// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11 (screens review item 14): a birthday held without its year read as the
// raw value, "Hélène's birthday is 07-26.", in the page's text, its Details and the home's lines,
// where every other date is said as a day. It reads "26 Jul" everywhere now, and a page whose text
// the hub wrote with the raw value is written again on the next night, touched or not (G786).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain, makeDemoBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { sayYearly } from "../src/diary";
import { factSentence } from "../src/dashboard/home";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { ownerSay } from "../src/owner-say";
import { readPage } from "../src/proofread";
import { DEMO_NOW } from "../scripts/demo-brain";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const rec = (v: string) => `{ value: "${v}", as_of: 2026-09-01, sources: ["owner:2026-09-01/notes"], verification: confirmed-by-owner, by: owner, recorded: 2026-09-01 }`;
function person(root: string, slug: string, title: string, facts: string) {
  writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-01\nby: owner\nfacts:\n${facts}---\n`);
  sh(root, "louis", "add", "-A"); sh(root, "louis", "commit", "-qm", `owner: ${slug}`);
}

test("G786 a yearly day held without its year is said as a day, only on a birthday or anniversary", () => {
  expect(sayYearly("birthday", "07-26")).toBe("26 Jul");
  expect(sayYearly("birthday", "--12-03")).toBe("3 Dec");
  expect(sayYearly("anniversary", "06-14")).toBe("14 Jun");
  // Not a day: left as written. Another attribute's "10-12" may be a range or a score.
  expect(sayYearly("birthday", "13-40")).toBe("13-40");
  expect(sayYearly("headcount", "10-12")).toBe("10-12");
  expect(sayYearly("birthday", "12 March")).toBe("12 March");
});

test("G786 the page writer says a birthday as a day, and a page it wrote with the raw value is written again", () => {
  const root = makeBrain();
  person(root, "mira-hale", "Mira Hale", `  birthday: ${rec("07-26")}\n  city: ${rec("Halifax")}\n`);
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/mira-hale")).toContain("Mira Hale's birthday is 26 Jul.");
  expect(body(root, "people/mira-hale")).not.toContain("07-26");
  // A page the hub wrote before this fix, long untouched: the next night writes it again.
  const file = join(root, "people", "mira-hale.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("birthday is 26 Jul.", "birthday is 07-26."));
  sh(root, "hub", "commit", "-qam", "hub: page text (old writer)");
  const r = renderTouchedPages(root, "2999-01-01T00:00:00Z");
  expect(r.written).toContain("people/mira-hale");
  expect(body(root, "people/mira-hale")).toContain("Mira Hale's birthday is 26 Jul.");
  // Once said as a day, nothing is written again.
  expect(renderTouchedPages(root, "2999-01-01T00:00:00Z").written).not.toContain("people/mira-hale");
});

test("G786 the home's sentence and Ask's answer say the day", () => {
  const root = makeBrain();
  person(root, "mira-hale", "Mira Hale", `  birthday: ${rec("07-26")}\n`);
  expect(factSentence("people/mira-hale", "Mira Hale", "birthday", "07-26", new Map())).not.toContain("07-26");
  expect(factSentence("people/mira-hale", "Mira Hale", "birthday", "07-26", new Map())).toContain("26 Jul");
  const a = ownerSay(root, "when is Mira Hale's birthday?");
  expect(a.text).toContain("26 Jul");
  expect(a.text).not.toContain("07-26");
});

test("G786 a person page's Details say the birthday as a day, and the nightly read counts a raw one", async () => {
  const { root } = await makeDemoBrain();
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = loadState(root);
    const html = ownerPage(s, "", s.notes.find((x) => x.fm.id === "people/helene-lefebvre")!, [], { fresh: true });
    expect(html).toContain("26 Jul");
    expect(html).not.toContain("07-26");
  } finally { delete process.env.PB_NOW; }
  // The nightly read's machine-date rule catches the old sentence, so a page the writer missed shows in the count.
  expect(readPage(`<h1>Mira Hale</h1><div class="prose"><p>Mira Hale's birthday is 07-26.</p><h2>References</h2>`)).toContain("machine-date");
  expect(readPage(`<h1>Mira Hale</h1><div class="prose"><p>Mira Hale's birthday is 26 Jul.</p><h2>References</h2>`)).not.toContain("machine-date");
}, 60_000);
