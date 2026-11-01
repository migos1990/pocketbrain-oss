// SPDX-License-Identifier: AGPL-3.0-only
// G601: reopenLostAccepts (run at every hub start) puts a capture the hub accepted with nothing
// saved back in the inbox. It dropped the proposal's `by` with the decided copy's (auto-decide), so
// the reopened proposal had no writer and waited as "It came from your own material" (owner's Mac
// after 47781905, 2026-11-01: 4 imports, 2 source captures). And a by-title capture whose write
// was handed back under the resolved page id (not_in_your_view) was reopened beside that handback.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { reopenLostAccepts } from "../src/write";
import { verdict } from "../src/filing";
import { loadEscalation } from "../src/textline/policy";
import { loadBrain } from "../src/brain";
import { git } from "../src/git";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const OWN = "It came from your own material, so it waits for you.";

function lostAccept(root: string, f = "2026-10-08-capture-aaaa1111.yaml") {
  mkdirSync(join(root, "inbox", "decided"), { recursive: true }); mkdirSync(join(root, "captures"), { recursive: true });
  writeFileSync(join(root, "captures", "2026-10-08-c1.md"), "---\nvia: import\nby: planner\n---\n- Jane works at Acme\n");
  writeFileSync(join(root, "inbox", "decided", f), YAML.stringify({ proposed: "2026-10-08", by: "auto-decide", decided: "2026-10-08", decision: "accept", reason: "capture captures/2026-10-08-c1.md: a new fact", checks: ["capture"], capture: "captures/2026-10-08-c1.md",
    request: { agent: "planner", kind: "fact", title: "Jane Roy", type: "person", attribute: "org", value: "Acme", as_of: "2026-10-08", sources: ["doc:capture/2026-10-08-c1"] } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: an accepted capture"]);
  return f;
}

test("G601: a reopened capture keeps its writer, so filing never calls it your own material", () => {
  const root = makeBrain();
  const f = lostAccept(root);
  expect(reopenLostAccepts(root)).toEqual([f]);
  const doc = YAML.parse(readFileSync(join(root, "inbox", f), "utf8"));
  expect(doc.by).toBe("planner");
  expect(doc.decision).toBeUndefined();
  const v = verdict(root, { kind: "proposal", key: `proposal:${f}`, ref: f } as never, loadEscalation(root), { notes: loadBrain(root) });
  expect(JSON.stringify(v)).not.toContain(OWN);
});

test("G601: a by-title capture whose handback already waits under the page's id is not reopened", () => {
  const root = makeBrain();
  const f = lostAccept(root);
  writeFileSync(join(root, "inbox", "2026-10-08-planner-bbbb2222.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "planner", reason: "the owner decides people/jane-roy#org (not_in_your_view)", checks: [],
    request: { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "org", value: "Acme", as_of: "2026-10-08", sources: ["agent:planner/capture/2026-10-08-c1"] } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: the handback"]);
  expect(reopenLostAccepts(root)).toEqual([]);
  expect(existsSync(join(root, "inbox", f))).toBe(false);
  expect(readdirSync(join(root, "inbox")).filter((x) => x.endsWith(".yaml"))).toEqual(["2026-10-08-planner-bbbb2222.yaml"]);
});

// The ones already reopened without a writer on the owner's Mac: filing reads the writer from the
// request (set by the server from the token, never the body) when the file has none.
test("G601: a proposal file with no by is judged as its request's agent", () => {
  const root = makeBrain();
  const f = lostAccept(root);
  const doc = YAML.parse(readFileSync(join(root, "inbox", "decided", f), "utf8"));
  const { decided: _d, decision: _x, by: _b, ...open } = doc;
  writeFileSync(join(root, "inbox", f), YAML.stringify(open));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: a reopened capture with no by"]);
  const v = verdict(root, { kind: "proposal", key: `proposal:${f}`, ref: f } as never, loadEscalation(root), { notes: loadBrain(root) });
  expect(JSON.stringify(v)).not.toContain(OWN);
});
