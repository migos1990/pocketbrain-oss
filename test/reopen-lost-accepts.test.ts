// SPDX-License-Identifier: AGPL-3.0-only
// Captures an older hub answered accepted with nothing saved (G431) go back to the inbox at the
// hub's start, where filing waits for the owner on them; one accepted and saved (linked as a name
// or not), one whose value a conflict packet holds, one already waiting under another name, and one whose page is gone stay where they are. Run twice, nothing moves.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { reopenLostAccepts } from "../src/write";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const decided = (root: string, name: string, request: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(root, "inbox", "decided", name), YAML.stringify({ proposed: "2026-10-25", by: "auto-decide", reason: "capture", checks: ["capture"], capture: "inbox/captures/x.md", request, decided: "2026-10-25", decision: "accept", ...extra }));
const req = (id: string, attribute: string, value: string) => ({ kind: "fact", agent: "steward", id, attribute, value, as_of: "2026-10-25", sources: ["gmail:f000000000000031"] });

test("an accepted capture with nothing saved goes back to the inbox, once; the others stay decided", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  writeFileSync(join(root, "people", "kai-moss.md"), `---\nid: people/kai-moss\ntype: person\ntitle: Kai Moss\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  org: { value: "Hill School", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07, sensitivity: private }\n  employer: { value: "[[orgs/river-lab|River Lab]]", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07 }\n  role: { value: "Coach", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07 }\n---\n`);
  decided(root, "2026-10-25-capture-lost0001.yaml", req("people/kai-moss", "org", "Bay Institute"));
  decided(root, "2026-10-25-capture-saved001.yaml", req("people/kai-moss", "role", "Coach"));
  decided(root, "2026-10-25-capture-linkd001.yaml", req("people/kai-moss", "employer", "River Lab"));
  decided(root, "2026-10-25-capture-twin0001.yaml", req("people/kai-moss", "org", "Lake Centre"));
  writeFileSync(join(root, "inbox", "2026-10-25-steward-again001.yaml"), YAML.stringify({ proposed: "2026-10-25", by: "steward", reason: "filed again", request: req("people/kai-moss", "org", "Lake Centre") }));
  decided(root, "2026-10-25-capture-gone0001.yaml", req("people/nobody-here", "org", "Lake Centre"));
  decided(root, "2026-10-25-capture-owner001.yaml", req("people/kai-moss", "org", "River Lab"), { by: "owner" });
  decided(root, "2026-10-25-capture-rejct001.yaml", req("people/kai-moss", "org", "Hill Lab"), { decision: "reject" });
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");

  expect(reopenLostAccepts(root)).toEqual(["2026-10-25-capture-lost0001.yaml"]);
  const back = YAML.parse(readFileSync(join(root, "inbox", "2026-10-25-capture-lost0001.yaml"), "utf8"));
  expect(back.request.value).toBe("Bay Institute");
  expect(back.decided).toBeUndefined();
  expect(back.capture).toBe("inbox/captures/x.md");
  expect(existsSync(join(root, "inbox", "decided", "2026-10-25-capture-lost0001.yaml"))).toBe(false);
  expect(readdirSync(join(root, "inbox", "decided")).sort()).toEqual(["2026-10-25-capture-gone0001.yaml", "2026-10-25-capture-linkd001.yaml", "2026-10-25-capture-owner001.yaml", "2026-10-25-capture-rejct001.yaml", "2026-10-25-capture-saved001.yaml", "2026-10-25-capture-twin0001.yaml"]);
  const log = sh(root, "git", "log", "-1", "--format=%an%n%B").stdout.toString();
  expect(log).toMatch(/^hub\n/);
  expect(log).toMatch(/Why: .*G431/);
  expect(sh(root, "git", "status", "--porcelain").stdout.toString().trim()).toBe("");
  expect(reopenLostAccepts(root)).toEqual([]);
});

test("a value a conflict packet holds is not lost", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  mkdirSync(join(root, "disputes"), { recursive: true });
  writeFileSync(join(root, "people", "kai-moss.md"), `---\nid: people/kai-moss\ntype: person\ntitle: Kai Moss\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  org: { value: "Hill School", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07, contested: c-0001 }\n---\n`);
  writeFileSync(join(root, "disputes", "c-0001.md"), `---\nid: disputes/c-0001\ntype: dispute\ntitle: people/kai-moss#org\narea: work\nsensitivity: personal\nstatus: open\ncreated: 2026-10-25\nupdated: 2026-10-25\nby: write-path\nfact_key: people/kai-moss#org\nstep: 7\ncandidates:\n  - { value: "Hill School", as_of: 2026-10-07, sources: ["gmail:f000000000000031"] }\n  - { value: "Bay Institute", as_of: 2026-10-25, sources: ["gmail:f000000000000032"] }\n---\n`);
  decided(root, "2026-10-25-capture-held0001.yaml", req("people/kai-moss", "org", "Bay Institute"));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  expect(reopenLostAccepts(root)).toEqual([]);
});

test("a new page that was never made comes back; an older last contact the write ignored, or a page named by id that is gone, doesn't", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  writeFileSync(join(root, "people", "kai-moss.md"), `---\nid: people/kai-moss\ntype: person\ntitle: Kai Moss\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  last_contact: { value: 2026-10-20, as_of: 2026-10-20, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-20 }\n---\n`);
  decided(root, "2026-10-25-capture-newpg001.yaml", { kind: "fact", agent: "steward", type: "person", title: "Zed Quill", area: "work", attribute: "role", value: "Coach", as_of: "2026-10-25", sources: ["gmail:f000000000000031"] });
  decided(root, "2026-10-25-capture-older001.yaml", req("people/kai-moss", "last_contact", "2026-10-12"));
  decided(root, "2026-10-25-capture-newer001.yaml", req("people/kai-moss", "last_contact", "2026-10-24"));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  expect(reopenLostAccepts(root).sort()).toEqual(["2026-10-25-capture-newer001.yaml", "2026-10-25-capture-newpg001.yaml"]);
  expect(sh(root, "git", "log", "-1", "--format=%B").stdout.toString()).toMatch(/Fact-Keys: .*person:Zed Quill#role/);
  expect(reopenLostAccepts(root)).toEqual([]);
});
