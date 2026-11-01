// SPDX-License-Identifier: AGPL-3.0-only
// G601 slice audit (tree bf9610e6), F1. A person the owner forgot comes back
// on its own: the hub's accepted new-page capture (decided, by-title, so forget's id match never
// removes it) is reopened at hub start by reopenLostAccepts; with G601 it gets `by: <capture agent>`
// back, so the filing tick files it again and re-creates the forgotten page. Before G601 it waited
// as "your own material" (still a leftover, but no page came back without the owner).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { makeModel } from "../src/model";
import { capture } from "../src/capture";
import { runAuto } from "../src/filing";
import { reopenLostAccepts } from "../src/write";
import { forgetPerson } from "../src/forget";
import { loadBrain } from "../src/brain";
import { weigh } from "./asked";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });
const later = (d: number) => new Date(Date.now() + d * 86_400_000);
const zed = (root: string) => loadBrain(root).filter((n) => n.fm.type === "person" && /zed/i.test(String(n.fm.title)));

test("G601 audit: a forgotten person's page never comes back on its own after a hub restart", async () => {
  const root = makeBrain();
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Zed Quill", type: "person", attribute: "role", value: "Plumber", quote: "Zed Quill is a plumber" }] }) });
  await capture(root, { kind: "text", text: "Zed Quill is a plumber" }, model);
  weigh(root, new Date());
  runAuto(root, later(1));
  const made = zed(root);
  expect(made.length).toBe(1);
  expect(readdirSync(join(root, "inbox", "decided")).some((f) => f.endsWith(".yaml"))).toBe(true);
  forgetPerson(root, made[0].fm.id);
  expect(zed(root).length).toBe(0);
  // the hub restarts: start.ts runs reopenLostAccepts, then the minute tick files
  const back = reopenLostAccepts(root);
  console.log("reopened:", back);
  weigh(root, later(2));
  console.log("filed:", runAuto(root, later(3)).map((d) => d.picked));
  expect(zed(root).length).toBe(0);
});

// The same person forgotten before this fix: the decided copy is still there (forget matched ids
// only), so reopen itself must not bring a new page back whose would-be id the owner forgot.
test("G601 audit: reopen never brings back a new page for a person the owner forgot earlier", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const YAML = (await import("yaml")).default;
  const { git } = await import("../src/git");
  const root = makeBrain();
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Zed Quill", type: "person", attribute: "role", value: "Plumber", quote: "Zed Quill is a plumber" }] }) });
  await capture(root, { kind: "text", text: "Zed Quill is a plumber" }, model);
  weigh(root, new Date());
  runAuto(root, later(1));
  const decided = readdirSync(join(root, "inbox", "decided")).filter((f) => f.endsWith(".yaml"));
  const keep = Object.fromEntries(decided.map((f) => [f, Bun.file(join(root, "inbox", "decided", f)).text()]));
  forgetPerson(root, zed(root)[0].fm.id);
  // As an older forget left it: the by-title decided copy put back.
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  for (const [f, t] of Object.entries(keep)) writeFileSync(join(root, "inbox", "decided", f), await t);
  git(root, ["add", "-A", "inbox"]); git(root, ["commit", "-q", "-m", "fixture: an older forget's leftover"]);
  void YAML;
  expect(reopenLostAccepts(root)).toEqual([]);
  weigh(root, later(2));
  runAuto(root, later(3));
  expect(zed(root).length).toBe(0);
});

// Already reopened on the owner's Mac before this fix, with no writer: filing never files it.
test("G601 audit: a new-page proposal for a forgotten name waits for the owner, whoever wrote it", async () => {
  const { writeFileSync } = await import("node:fs");
  const YAML = (await import("yaml")).default;
  const { git } = await import("../src/git");
  const { verdict } = await import("../src/filing");
  const { loadEscalation } = await import("../src/textline/policy");
  const root = makeBrain();
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Zed Quill", type: "person", attribute: "role", value: "Plumber", quote: "Zed Quill is a plumber" }] }) });
  await capture(root, { kind: "text", text: "Zed Quill is a plumber" }, model);
  weigh(root, new Date());
  runAuto(root, later(1));
  const [f] = readdirSync(join(root, "inbox", "decided")).filter((x) => x.endsWith(".yaml"));
  const doc = YAML.parse(await Bun.file(join(root, "inbox", "decided", f)).text());
  forgetPerson(root, zed(root)[0].fm.id);
  const { decided: _d, decision: _x, by: _b, ...open } = doc;
  writeFileSync(join(root, "inbox", f), YAML.stringify(open));
  git(root, ["add", "-A", "inbox"]); git(root, ["commit", "-q", "-m", "fixture: reopened with no by, before G601"]);
  const v = verdict(root, { kind: "proposal", key: `proposal:${f}`, ref: f } as never, loadEscalation(root), { notes: loadBrain(root) }, later(2));
  expect("never" in v).toBe(true);
  runAuto(root, later(3));
  expect(zed(root).length).toBe(0);
});

// Builder's security review of e80ac6ae (low): a forget the owner undid no longer holds that name.
test("G601 audit: after forget --undo, a new-page proposal by that name is not held as forgotten", async () => {
  const { forgottenSlugs, forgottenName } = await import("../src/write");
  const { undoForget } = await import("../src/forget");
  const root = makeBrain();
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Zed Quill", type: "person", attribute: "role", value: "Plumber", quote: "Zed Quill is a plumber" }] }) });
  await capture(root, { kind: "text", text: "Zed Quill is a plumber" }, model);
  weigh(root, new Date());
  runAuto(root, later(1));
  const id = zed(root)[0].fm.id;
  forgetPerson(root, id);
  expect(forgottenName("Zed Quill", forgottenSlugs(root))).toBe(true);
  undoForget(root, id);
  expect(forgottenName("Zed Quill", forgottenSlugs(root))).toBe(false);
});
