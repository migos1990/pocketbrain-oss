// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11 Medium (G646): the text box wrote a health value on the 30-day sign-in when its fact had
// a conflict waiting in the inbox. G610 (audit v10) made a typed answer on a private dispute wait for
// a fresh sign-in, as the settle buttons do, but a conflict that waits in the inbox (src/settle-inbox.ts)
// was not looked at: the box wrote over its hidden sides. Now it waits for a fresh sign-in too, and
// right after one it settles that conflict as a typed answer.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { inboxConflicts } from "../src/settle-inbox";
import { ownerSay } from "../src/owner-say";

const ID = "people/jane-roy";
function brain() {
  const root = makeBrain();
  const w = (value: string) => write(root, { agent: "planner", id: ID, attribute: "medical", value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  expect(w("a diagnosis of diabetes").outcome).toBe("committed");
  w("a diagnosis of asthma");
  const open = inboxConflicts(root).filter((c) => c.fact_key === `${ID}#medical`);
  expect(open).toHaveLength(1);
  expect(open[0]!.private).toBe(true);
  return root;
}
const medical = (root: string) => (loadBrain(root).find((n) => n.fm.id === ID)!.fm.facts!.medical as FactRecord).value;

test("a typed health value on a fact with a private inbox conflict, on the 30-day sign-in, writes nothing", () => {
  const root = brain();
  const reply = ownerSay(root, "Jane Roy's medical is a diagnosis of migraines", { fresh: false });
  expect(reply.signin).toBe(true);
  expect(reply.text).not.toContain("migraines");
  expect(reply.text).not.toContain("asthma");
  expect(medical(root)).toBe("a diagnosis of diabetes");
  expect(inboxConflicts(root).filter((c) => c.fact_key === `${ID}#medical`)).toHaveLength(1);
});

test("right after a sign-in the same sentence settles the inbox conflict with the owner's word", () => {
  const root = brain();
  const reply = ownerSay(root, "Jane Roy's medical is a diagnosis of migraines", { fresh: true });
  expect(reply.kind).toBe("say.settled");
  expect(medical(root)).toBe("a diagnosis of migraines");
  expect(inboxConflicts(root).filter((c) => c.fact_key === `${ID}#medical`)).toHaveLength(0);
});

// The audit's fix goes further: the box waits for a fresh sign-in whenever the value it would write is
// private, not only when a conflict waits. A plain health sentence on the 30-day sign-in writes nothing.
test("a plain health sentence on the 30-day sign-in writes nothing and asks for a sign-in", () => {
  const root = makeBrain();
  const before = loadBrain(root).find((n) => n.fm.id === ID)!.fm.facts?.medical;
  const reply = ownerSay(root, "Jane Roy's medical is mild hay fever", { fresh: false });
  expect(reply.signin).toBe(true);
  expect(reply.text).not.toContain("hay fever");
  expect(loadBrain(root).find((n) => n.fm.id === ID)!.fm.facts?.medical).toEqual(before);
  const after = ownerSay(root, "Jane Roy's medical is mild hay fever", { fresh: true });
  expect(after.signin).toBeFalsy();
  expect((loadBrain(root).find((n) => n.fm.id === ID)!.fm.facts!.medical as FactRecord).value).toBe("mild hay fever");
});
