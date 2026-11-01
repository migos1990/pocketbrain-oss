// SPDX-License-Identifier: AGPL-3.0-only
// G622: a proposal filed by name (no id) that contradicts a live value on a page holding a private
// fact is a conflict to filing ("Two sources disagree about a page that holds a private fact"), so
// it is one on the owner's home and settle screen too: inboxConflicts resolves the name to its page
// the way filing does (resolveEntity), and a name that fits more than one page stays off the list.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadBrain, type FactRecord } from "../src/brain";
import { inboxConflicts, settleInbox } from "../src/settle-inbox";

function byName(title: string) {
  const root = makeBrain();
  write(root, { agent: "owner", id: "people/jane-roy", attribute: "health_note", value: "x", as_of: "2026-10-07", sources: ["owner:2026-10-07/home"], verification: "confirmed-by-owner", sensitivity: "private" } as never, { owner: true });
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-by-name.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "steward", reason: "a page holding a private fact", request: { agent: "steward", kind: "fact", type: "person", title, attribute: "role", value: "Dean of studies", as_of: "2026-10-07", sources: ["gmail:f000000000000005"], verification: "verified-by-source" } }));
  git(root, ["add", "inbox"]); git(root, ["commit", "-q", "-m", "steward: proposal by name"]);
  return root;
}

const role = (root: string) => (loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).value;

test("a by-name proposal that contradicts its page's live value is a conflict on the settle list, and settles there", () => {
  const root = byName("Jane Roy");
  const role0 = role(root);
  const cs = inboxConflicts(root);
  expect(cs).toHaveLength(1);
  expect(cs[0]!.page).toBe("people/jane-roy");
  expect(cs[0]!.fact_key).toBe("people/jane-roy#role");
  expect(cs[0]!.sides.map((s) => s.value)).toEqual([role0, "Dean of studies"]);
  settleInbox(root, cs[0]!.id, { n: 2 });
  expect(role(root)).toBe("Dean of studies");
  expect(inboxConflicts(root)).toHaveLength(0);
}, 60_000);

test("a by-name proposal whose name fits no page is not a conflict", () => {
  const root = byName("Nobody Here");
  expect(inboxConflicts(root)).toHaveLength(0);
}, 60_000);
