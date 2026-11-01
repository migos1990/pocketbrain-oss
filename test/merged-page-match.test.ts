// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10 (2026-11-01), finding 2d: resolveEntity matched a name against every page of the type,
// merged pointers included. After a same-person merge the dropped page keeps its title and points
// at the kept one (status merged, merged_into), so the name fit two pages and every write by that
// name waited as "Its name fits more than one note" (the audit traced the owner's held_by_ambiguity to it).
// A merged page stands for the page it was merged into; one the writer can't see matches nothing.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write, resolveEntity } from "../src/write";
import { loadBrain, type Note } from "../src/brain";
import { git } from "../src/git";
import { verdict } from "../src/filing";
import { loadEscalation } from "../src/textline/policy";

const person = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ path: `${id}.md`, body: "", fm: { id, type: "person", title, area: "work", sensitivity: "personal", ...extra } }) as unknown as Note;

test("a merged page's name resolves to the page it was merged into, not to two pages", () => {
  const notes = [
    person("people/sam-ortiz", "Sam Ortiz", { status: "merged", merged_into: "people/samuel-ortiz" }),
    person("people/samuel-ortiz", "Samuel Ortiz", { aliases: ["Sam Ortiz"] }),
  ];
  expect(resolveEntity(notes, "person", "Sam Ortiz")).toEqual({ id: "people/samuel-ortiz" });
  // The kept page without the alias: the merged title still finds it.
  expect(resolveEntity([notes[0], person("people/samuel-ortiz", "Samuel Ortiz")], "person", "Sam Ortiz")).toEqual({ id: "people/samuel-ortiz" });
  // A merge chain is followed to its end.
  const chain = [
    person("people/s-ortiz", "S. Ortiz", { status: "merged", merged_into: "people/sam-ortiz" }),
    ...notes,
  ];
  expect(resolveEntity(chain, "person", "S. Ortiz")).toEqual({ id: "people/samuel-ortiz" });
  // Near matches skip merged pointers too.
  expect(resolveEntity(notes, "person", "Samuel Ortiz")).toEqual({ id: "people/samuel-ortiz" });
});

test("a merged page whose kept page the writer can't see matches nothing, like a missing page", () => {
  const pointer = person("people/sam-ortiz", "Sam Ortiz", { status: "merged", merged_into: "people/samuel-ortiz" });
  expect(resolveEntity([pointer], "person", "Sam Ortiz")).toEqual({});
  expect(resolveEntity([], "person", "Sam Ortiz")).toEqual({});
});

test("the hub's filing of a proposal by a merged page's name doesn't wait as ambiguous", () => {
  const root = makeBrain();
  const fm = (id: string, title: string, extra: string) => `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: work\nsensitivity: personal\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n${extra}---\n`;
  writeFileSync(join(root, "people", "samuel-ortiz.md"), fm("people/samuel-ortiz", "Samuel Ortiz", "aliases: [Sam Ortiz]\n"));
  writeFileSync(join(root, "people", "sam-ortiz.md"), fm("people/sam-ortiz", "Sam Ortiz", "status: merged\nmerged_into: people/samuel-ortiz\n"));
  git(root, ["add", "people"]); git(root, ["commit", "-q", "-m", "owner: merge sam ortiz"]);
  // An imported capture's fact by name, with filing on, as on the owner's hub: the hub weighs it
  // with every note, merged pointers included.
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "c1.md"), "---\nvia: import\nby: planner\n---\nx\n");
  writeFileSync(join(root, "inbox", "2026-10-06-planner-c1.yaml"), "by: planner\ncapture: inbox/captures/c1.md\nreason: \"captured: a new fact\"\nrequest: { agent: planner, kind: fact, title: Sam Ortiz, type: person, area: work, attribute: office, value: Room 4, as_of: 2026-10-05, sources: [\"gmail:f000000000000006\"] }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: a capture by name"]);
  const v = verdict(root, { kind: "proposal", key: "proposal:2026-10-06-planner-c1.yaml", ref: "2026-10-06-planner-c1.yaml" } as never, loadEscalation(root), { notes: loadBrain(root) });
  expect(JSON.stringify(v)).not.toContain("fits more than one");
  // And the hub's own write by that name lands on the kept page.
  const w = write(root, { agent: "planner", kind: "fact", title: "Sam Ortiz", type: "person", area: "work", attribute: "office", value: "Room 4", as_of: "2026-10-05", sources: ["gmail:f000000000000006"] } as never, { acceptedBy: "auto-decide" });
  expect(w.outcome).not.toBe("inbox");
  expect((loadBrain(root).find((n) => n.fm.id === "people/samuel-ortiz")!.fm.facts?.office as { value?: string } | undefined)?.value).toBe("Room 4");
});
