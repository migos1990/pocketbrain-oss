// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-07, a person page: the role already named its org, so the page read
// "Organisateur … d'Option Voisins at Option Voisins" (G729), and "X also comes up in
// the sources of Y" tied the person to a page the page's own text already linked, which read as
// filler (G730). Made-up names; the shapes are the real page's.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { nameKey } from "../src/mentions";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const SINCE = "2000-01-01T00:00:00Z";
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: "${value}", as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n`;
function page(root: string, id: string, type: string, title: string, facts: string, text = "") {
  mkdirSync(join(root, id.split("/")[0]!), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n${facts}---\n${text}`);
}
const commit = (root: string) => { sh(root, "steward", "add", "-A"); sh(root, "steward", "commit", "-qm", "steward: setup"); };
function org(root: string) { page(root, "orgs/option-voisins", "org", "Option Voisins", fact("kind", "consumer group", "gmail:f000000000000020")); }

test("G729 a role that already names its org is said once, the org's name in it linking its page", () => {
  const root = makeBrain();
  org(root);
  page(root, "people/chris-dorval", "person", "Chris Dorval", fact("role", "Organisateur de la réunion du conseil d'administration d'Option Voisins", "gmail:f000000000000021") + fact("org", "[[orgs/option-voisins]]", "gmail:f000000000000021"));
  page(root, "people/dana-pike", "person", "Dana Pike", fact("role", "organiser of the option voisins board meeting", "gmail:f000000000000022") + fact("org", "[[orgs/option-voisins]]", "gmail:f000000000000022"));
  commit(root);
  renderTouchedPages(root, SINCE);
  const c = body(root, "people/chris-dorval");
  expect(c).toContain("d'administration d'[[orgs/option-voisins|Option Voisins]].[^pf-role][^pf-org]");
  expect(c).not.toMatch(/Option Voisins(?:\]\])? at /);
  expect(c).not.toContain("works at [[orgs/option-voisins");
  // Case and accents aside, the org's name as written in the role links.
  expect(body(root, "people/dana-pike")).toContain("organiser of the [[orgs/option-voisins|option voisins]] board meeting.[^pf-role][^pf-org]");
  // A role that doesn't name it still reads with its org.
  page(root, "people/eli-novak", "person", "Eli Novak", fact("role", "treasurer", "gmail:f000000000000023") + fact("org", "[[orgs/option-voisins]]", "gmail:f000000000000023"));
  commit(root);
  renderTouchedPages(root, SINCE);
  expect(body(root, "people/eli-novak")).toContain("Eli Novak is the treasurer at [[orgs/option-voisins|Option Voisins]].");
});

test("G730 a page the page's own text already links is never named again as 'also comes up in the sources of'", () => {
  const root = makeBrain();
  org(root);
  page(root, "people/chris-dorval", "person", "Chris Dorval", fact("city", "Laval", "gmail:f000000000000024"), "## Earlier notes\nRelated: [[projects/voisins-board-role]]\n");
  page(root, "projects/voisins-board-role", "project", "Option Voisins board role", fact("next_step", "send the minutes", "gmail:f000000000000025"));
  page(root, "projects/spring-fair", "project", "Spring fair", fact("next_step", "book the hall", "gmail:f000000000000026"));
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  for (const ref of ["gmail:f000000000000025", "gmail:f000000000000026"])
    writeFileSync(join(root, "inbox", "captures", `2026-10-05-${ref.slice(-8)}.md`), `---\n${YAML.stringify({ id: `2026-10-05-${ref.slice(-8)}`, kind: "text", via: "source", source_ref: ref, name_keys: [nameKey("Chris Dorval")], status: "extracted" })}---\nNot kept here.\n`);
  commit(root);
  renderTouchedPages(root, SINCE);
  const c = body(root, "people/chris-dorval");
  // The page the Earlier notes line links isn't tied again; another page the sources name still is.
  expect(c).toContain("also comes up in the sources of [[projects/spring-fair|Spring fair]].");
  expect(c).not.toContain("sources of [[projects/voisins-board-role");
  expect(c).not.toMatch(/also comes up in the sources of[^.]*Option Voisins board role/);
});

// The page's band on the owner's phone (same screenshot): the line under the name said the org twice,
// and the area chip printed a two-letter area alone ("Ov"). A chip shows the area's label from
// policy, a short slug in capitals, and none when it would only repeat the org the line names.
async function phone(extraPolicy: string) {
  const { makeDemoBrain } = await import("./fixture");
  const { DEMO_NOW } = await import("../scripts/demo-brain");
  const { dashboardHandler } = await import("../src/dashboard/server");
  const { root } = await makeDemoBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("areas:\n", `areas:\n${extraPolicy}`));
  page(root, "orgs/option-voisins", "org", "Option Voisins", fact("kind", "consumer group", "gmail:000000000000e1f7"));
  for (const [f, area] of [["orgs/option-voisins.md", "ov"]] as const) writeFileSync(join(root, f), readFileSync(join(root, f), "utf8").replace("area: work", `area: ${area}`));
  page(root, "people/chris-dorval", "person", "Chris Dorval", fact("role", "Organisateur de la réunion du conseil d'administration d'Option Voisins", "gmail:000000000000e1f7") + fact("org", "[[orgs/option-voisins]]", "gmail:000000000000e1f7"));
  writeFileSync(join(root, "people/chris-dorval.md"), readFileSync(join(root, "people/chris-dorval.md"), "utf8").replace("area: work", "area: ov"));
  page(root, "projects/voisins-fair", "project", "Voisins fair", fact("next_step", "book the hall", "gmail:000000000000e1f7"));
  writeFileSync(join(root, "projects/voisins-fair.md"), readFileSync(join(root, "projects/voisins-fair.md"), "utf8").replace("area: work", "area: ov"));
  // The org said in plain words, and a role alone that names it (use-it on the Mac, 2026-11-08; G736).
  page(root, "people/eve-roy", "person", "Eve Roy", fact("role", "Organisateur de la réunion du conseil d'administration d'Option Voisins", "gmail:000000000000e1f7") + fact("org", "Option Voisins", "gmail:000000000000e1f7"));
  page(root, "people/fay-lin", "person", "Fay Lin", fact("role", "Secrétaire du conseil d'Option Voisins", "gmail:000000000000e1f7"));
  for (const f of ["people/eve-roy.md", "people/fay-lin.md"]) writeFileSync(join(root, f), readFileSync(join(root, f), "utf8").replace("area: work", "area: ov"));
  sh(root, "owner", "add", "-A"); sh(root, "owner", "commit", "-qm", "owner: setup");
  const H = "127.0.0.1:8799";
  const d = dashboardHandler(root, { port: 8799, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  process.env.PB_NOW = DEMO_NOW;
  const get = async (id: string) => (await d.handle(new Request(`http://${H}/p/${id}`, { headers: { host: H, cookie } }))).text();
  try { return { chris: await get("people/chris-dorval"), fair: await get("projects/voisins-fair"), eve: await get("people/eve-roy"), fay: await get("people/fay-lin") }; }
  finally { delete process.env.PB_NOW; }
}

test("G731 the line under a person's name says a role that names its org once", async () => {
  const { chris } = await phone("  ov: { owner: claude }\n");
  expect(chris).toMatch(/<p class="kind">Organisateur de la réunion du conseil d(?:'|&#39;)administration d(?:'|&#39;)Option Voisins<\/p>/);
  expect(chris).not.toMatch(/Option Voisins at Option Voisins/);
}, 60_000);

test("G732 the area chip is never a lone short slug, and never repeats the org the line names", async () => {
  const bare = await phone("  ov: { owner: claude }\n");
  // "OV" is Option Voisins' initials: the line already names it.
  expect(bare.chris).not.toMatch(/<span class="chip">(?:Ov|OV)<\/span>/);
  expect(bare.fair).toContain('<span class="chip">OV</span>');
  expect(bare.fair).not.toContain('<span class="chip">Ov</span>');
  const named = await phone("  ov: { owner: claude, label: Neighbours board }\n");
  expect(named.fair).toContain('<span class="chip">Neighbours board</span>');
  expect(named.chris).toContain('<span class="chip">Neighbours board</span>');
  const same = await phone("  ov: { owner: claude, label: Option Voisins }\n");
  expect(same.chris).not.toContain('<span class="chip">Option Voisins</span>');
  expect(same.fair).toContain('<span class="chip">Option Voisins</span>');
}, 120_000);

test("G736 the area chip drops beside a line naming the org even when the org fact is plain words, or only the role names it", async () => {
  const bare = await phone("  ov: { owner: claude }\n");
  for (const html of [bare.eve, bare.fay]) {
    expect(html).toContain("Option Voisins</p>");
    expect(html).not.toMatch(/<span class="chip">OV<\/span>/);
  }
  const same = await phone("  ov: { owner: claude, label: Option Voisins }\n");
  for (const html of [same.eve, same.fay]) expect(html).not.toContain('<span class="chip">Option Voisins</span>');
  // A label that isn't the org still shows.
  const named = await phone("  ov: { owner: claude, label: Neighbours board }\n");
  for (const html of [named.eve, named.fay]) expect(html).toContain('<span class="chip">Neighbours board</span>');
}, 120_000);
