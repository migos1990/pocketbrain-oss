// SPDX-License-Identifier: AGPL-3.0-only
// The Mac's probe 2026-11-09: a person's org fact linked an org page the brain never had, so the
// two pages never tied and the person failed the north star. A link the pipeline made to a page that
// doesn't exist is an open question about data: one ask in the owner's words, nothing changed
// before his tap; his pick is his word on the fact; leaving it is remembered (G749).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";

const sh = (root: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=steward@pocketbrain.local", ...a], { cwd: root }).stdout.toString().trim();
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: "${value}", as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n`;
function page(root: string, id: string, type: string, title: string, facts: string) {
  mkdirSync(join(root, id.split("/")[0]!), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n${facts}---\n`);
}
function brain() {
  const root = makeBrain();
  page(root, "orgs/option-voisins", "org", "Option Voisins", fact("kind", "consumer group", "gmail:f000000000000031"));
  page(root, "orgs/voisins-club", "org", "Voisins Club", fact("kind", "club", "gmail:f000000000000032"));
  page(root, "people/chris-dorval", "person", "Chris Dorval", fact("org", "[[orgs/option-voisins-qc]]", "gmail:f000000000000033"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "steward: setup");
  return root;
}

test("G749 a fact linking a page that doesn't exist raises one ask in the owner's words, and changes nothing", async () => {
  const { raiseLinkAsks, waitingLinkAsks } = await import("../src/dangling");
  const root = brain();
  const before = readFileSync(join(root, "people", "chris-dorval.md"), "utf8");
  // Report-only: found, never filed.
  expect(raiseLinkAsks(root, { apply: false }).length).toBe(1);
  expect(waitingLinkAsks(root).length).toBe(0);
  raiseLinkAsks(root);
  const [a] = waitingLinkAsks(root);
  expect(a!.question).toBe(`Chris Dorval's workplace points to a page you don't have ("option voisins qc"). Which did you mean?`);
  expect(a!.choices[0]).toBe("orgs/option-voisins");
  expect(readFileSync(join(root, "people", "chris-dorval.md"), "utf8")).toBe(before);
  // Never asked twice.
  expect(raiseLinkAsks(root).length).toBe(0);
  // It is something waiting on the owner.
  const { ownerAsks } = await import("../src/waiting");
  expect(ownerAsks(root).by.link).toBe(1);
});

test("G749 his pick is his word on the fact; leaving it is remembered", async () => {
  const { raiseLinkAsks, waitingLinkAsks, answerLink, linkAsks } = await import("../src/dangling");
  const root = brain();
  raiseLinkAsks(root);
  const [a] = waitingLinkAsks(root);
  answerLink(root, a!.key, { pick: "orgs/option-voisins" });
  const chris = loadBrain(root).find((n) => n.fm.id === "people/chris-dorval")!;
  expect(JSON.stringify(chris.fm.facts!.org)).toContain("[[orgs/option-voisins]]");
  expect(JSON.stringify(chris.fm.facts!.org)).toContain("confirmed-by-owner");
  expect(waitingLinkAsks(root).length).toBe(0);
  // A page not offered is refused.
  const root2 = brain();
  raiseLinkAsks(root2);
  const [b] = waitingLinkAsks(root2);
  expect(() => answerLink(root2, b!.key, { pick: "people/chris-dorval" })).toThrow();
  answerLink(root2, b!.key, "no");
  expect(linkAsks(root2)[0]!.status).toBe("no");
  expect(raiseLinkAsks(root2).length).toBe(0);
  expect(existsSync(join(root2, "inbox", "links"))).toBe(true);
});

test("G749 the home lists the question with a tap for each page offered, a plain name, and leave it", async () => {
  const { raiseLinkAsks } = await import("../src/dangling");
  const { homeWaiting } = await import("../src/dashboard/home");
  const root = brain();
  raiseLinkAsks(root);
  const v = { waiting: homeWaiting(root, new Date()) };
  const w = v.waiting.find((x) => x.link);
  expect(w?.what).toContain("points to a page you don't have");
  expect(w?.choices?.map((c) => c.label)).toEqual(["Option Voisins", "Voisins Club", "Keep it as a name", "Leave it"]);
});

test("G749 the night pass only counts them until the owner turns the question on", async () => {
  const { upkeep } = await import("../src/upkeep");
  const { waitingLinkAsks } = await import("../src/dangling");
  const root = brain();
  const r = upkeep(root);
  expect(r.findings.some((f: { rule: string }) => f.rule === "link-would-ask")).toBe(true);
  expect(waitingLinkAsks(root).length).toBe(0);
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, `links: { ask: true }\n${readFileSync(pol, "utf8")}`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "owner: links on");
  upkeep(root);
  expect(waitingLinkAsks(root).length).toBe(1);
}, 60_000);
