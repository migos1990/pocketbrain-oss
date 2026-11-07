// SPDX-License-Identifier: AGPL-3.0-only
// Mac sweep 2026-11-07: pages whose footnotes read "No source given" while the facts behind them
// were filed by someone known. An assistant may file a fact as unverified (checks.ts allows the
// ref "unverified" with that verification); its footnote says an assistant told it, never which one (G720).
// The hub's own surname guess (family.ts, G546) keeps its hedged sentence, and its footnote says
// it was guessed from the names (G721). Neither ever reads "No source given".
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages, reference } from "../src/wiki";
import { readNote } from "../src/core";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---");
const head = (id: string, title: string) => `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: town\n`;

test("G720 an assistant's unverified fact is footnoted as an assistant's note, never No source given and never by the assistant's name", () => {
  const root = makeBrain();
  writeFileSync(join(root, "people", "ana-diaz.md"), `${head("people/ana-diaz", "Ana Diaz")}facts:\n  role: { value: "lecturer", as_of: 2026-11-02, sources: [unverified], verification: unverified, by: town, recorded: 2026-11-02 }\n---\n`);
  sh(root, "town", "add", "-A"); sh(root, "town", "commit", "-qm", "town: Ana");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const b = body(root, "people/ana-diaz");
  expect(b).toContain("lecturer");
  expect(b).not.toContain("No source given");
  expect(b).not.toMatch(/town/i);
  expect(b).toMatch(/^\[\^pf-role\]: An assistant's note, 2026-11-02$/m);
});

test("G721 the hub's surname guess keeps its hedged sentence, and its footnote says it was guessed from the names", () => {
  const r = { value: "[[people/robin]]", as_of: "2026-11-01", sources: ["unverified"], verification: "unverified", confidence: "inferred", by: "hub", recorded: "2026-11-01" } as never;
  expect(reference(r)).toBe("Guessed from the names, 2026-11-01");
  // A fact with no source and no teller still says so plainly.
  expect(reference({ value: "x", as_of: "2026-11-01", sources: [], verification: "unverified", recorded: "2026-11-01" } as never)).toBe("No source given, 2026-11-01");
  // The owner's own unverified word is theirs.
  expect(reference({ value: "x", as_of: "2026-11-01", sources: ["unverified"], verification: "unverified", by: "owner", recorded: "2026-11-01" } as never)).toBe("Your note, 2026-11-01");
});

test("G720 a page not yet rewritten still drops an old No source given sentence once its fact is hidden from the reader", () => {
  const root = makeBrain();
  const fact = (s: string) => `{ value: "lecturer", as_of: 2026-11-02, sources: [unverified], verification: unverified, by: town, recorded: 2026-11-02${s} }`;
  const page = (s: string) => `${head("people/ana-diaz", "Ana Diaz")}facts:\n  role: ${fact(s)}\n---\nAna Diaz is a lecturer.[^old-role] She likes long walks.\n\n[^old-role]: No source given, 2026-11-02\n`;
  writeFileSync(join(root, "people", "ana-diaz.md"), page(""));
  sh(root, "town", "add", "-A"); sh(root, "town", "commit", "-qm", "town: Ana");
  expect((readNote(root, "helper", "people/ana-diaz") as { body: string }).body).toContain("is a lecturer");
  writeFileSync(join(root, "people", "ana-diaz.md"), page(", sensitivity: private"));
  sh(root, "owner", "commit", "-qam", "owner: Ana's role private");
  const b = (readNote(root, "helper", "people/ana-diaz") as { body: string }).body;
  expect(b).not.toContain("lecturer");
  expect(b).toContain("long walks");
});

test("G720 the page a planner reads, holding a fact helper filed as unverified, never names helper", () => {
  const root = makeBrain();
  writeFileSync(join(root, "people", "ana-diaz.md"), `${head("people/ana-diaz", "Ana Diaz")}facts:\n  role: { value: "lecturer", as_of: 2026-11-02, sources: [unverified], verification: unverified, by: helper, recorded: 2026-11-02 }\n---\n`);
  sh(root, "helper", "add", "-A"); sh(root, "helper", "commit", "-qm", "helper: Ana");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const b = (readNote(root, "planner", "people/ana-diaz") as { body: string }).body;
  expect(b).toContain("lecturer");
  expect(b).not.toMatch(/helper/i);
});
