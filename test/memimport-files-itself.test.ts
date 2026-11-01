// SPDX-License-Identifier: AGPL-3.0-only
// G587: a core assistant's memory export, forwarded by the owner (`pocketbrain memsync import`),
// files itself like a capture: a new fact lands with Undo, a different value is a conflict. On the
// owner's Mac claude.ai's 22 imported facts were planned to expire, because only the capture agent's
// and the owner's captured proposals filed and every other one fell through to the expiry rule.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { makeModel } from "../src/model";
import { importMemory } from "../src/memimport";
import { runAuto } from "../src/filing";
import { captureAgent } from "../src/capture";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { weigh } from "./asked";
import { write } from "../src/write";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const model = () => makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [
  { entity: "Jane Roy", type: "person", attribute: "org", value: "Acme", quote: "Jane works at Acme" },
  { entity: "Course A", type: "project", attribute: "next_step", value: "Print the midterm", quote: "Course A: next step is to print the midterm" },
] }) });
const later = () => new Date(Date.now() + 40 * 86_400_000);

async function imported(who: string) {
  const root = makeBrain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  writeFileSync(join(dir, "m.md"), "- Jane works at Acme\n- Course A: next step is to print the midterm\n");
  await importMemory(root, who, [dir], model());
  weigh(root, new Date()); // the hub sees the proposals as they arrive
  return root;
}

test("G587: a core assistant's imported memory files itself, never expires", async () => {
  const root = await imported("planner");
  expect(captureAgent(loadRules(root))).not.toBe("planner");
  const picked = runAuto(root, later()).map((d) => d.picked).sort();
  expect(picked).not.toContain("lets it expire");
  expect(picked).toEqual(["held it as a conflict", "saved it"]);
  expect(readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"))).toEqual([]);
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  expect(JSON.stringify(jane.fm.facts?.org)).toContain("Acme");
});

test("G587: a trial assistant's imported memory still only proposes, and expires unanswered", async () => {
  const root = await imported("helper");
  expect(runAuto(root, later()).map((d) => d.picked)).toEqual(["lets it expire", "lets it expire"]);
});

// G587 slice audit F2: an assistant's newer word for a value that a source holds is a conflict,
// never an update, however the value's own sources are spelled (here a capture's doc: ref).
test("G587: an imported newer value never replaces a source's value without a conflict", async () => {
  const root = makeBrain();
  const w = write(root, { agent: "steward", kind: "fact", id: "people/jane-roy", attribute: "org", value: "Globex", as_of: "2026-10-01", sources: ["doc:capture/2026-10-01-aaaa"], source_type: "document" } as never);
  expect(w.outcome).not.toBe("refused");
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  writeFileSync(join(dir, "m.md"), "- Jane works at Acme\n");
  await importMemory(root, "planner", [dir], makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Jane Roy", type: "person", attribute: "org", value: "Acme", quote: "Jane works at Acme", as_of: "2026-10-08" }] }) }));
  weigh(root, new Date());
  expect(runAuto(root, later()).map((d) => d.picked)).toEqual(["held it as a conflict"]);
});
