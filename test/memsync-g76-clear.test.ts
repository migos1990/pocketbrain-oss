// SPDX-License-Identifier: AGPL-3.0-only
// Red team: the soak's "a stuck fix clears when the answer is right" lets an agent with readable
// memory files clear the owner's G76 card ("<file> is a link now; fix it by hand") by answering one
// quiz question it got from its own changes_seen, while the link is still in its folder.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as ms from "../src/memsync";
import { setFact } from "../src/dashboard/edit";
import { digest } from "../src/digest";

test("a needs-hand card for a memory file swapped for a link isn't cleared by the agent's quiz answer", () => {
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-"));
  const root = makeBrain();
  const mem = mkdtempSync(join(tmpdir(), "pb-mem-"));
  writeFileSync(join(mem, "people.md"), "# People\n\nJane Roy's role is Course coordinator.\n");
  const pf = join(root, "rules", "policy.yaml");
  writeFileSync(pf, readFileSync(pf, "utf8").replace("planner: { tier: core,", `planner: { tier: core, memory: { files: [${mem}] },`));
  Bun.spawnSync(["git", "commit", "-qam", "mem"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  ms.memoryCheck(root, "planner"); // baseline
  setFact(root, "people/jane-roy", "role", "Department chair");
  const [f] = ms.scan(root, "planner");
  expect(f.correction).toBeDefined();
  // the agent swaps its file for a link to something else on the hub
  const target = join(mkdtempSync(join(tmpdir(), "pb-other-")), "x.md");
  writeFileSync(target, "Jane Roy's role is Course coordinator.\n");
  rmSync(join(mem, "people.md")); symlinkSync(target, join(mem, "people.md"));
  ms.approve(root, f.correction!);
  expect(ms.state(root).corrections.find((c) => c.id === f.correction)!.state).toBe("needs-hand");
  // the agent: memory_check, changes_seen, answer the recheck question from the feed
  const chk = ms.memoryCheck(root, "planner");
  ms.memoryReply(root, "planner", { changes_seen: chk.changes!.id });
  const qs = ms.memoryCheck(root, "planner").questions.filter((q) => q.question.includes("Jane Roy"));
  ms.memoryReply(root, "planner", { answers: qs.map((q) => ({ id: q.id, answer: "Department chair" })) });
  const st = ms.state(root).corrections.find((c) => c.id === f.correction)!.state;
  expect(st).toBe("needs-hand");
});
