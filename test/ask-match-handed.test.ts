// SPDX-License-Identifier: AGPL-3.0-only
// Ask to see, found recording the identity demo (2026-11-15): asked for "Mom's move in December",
// the first match was a person's page whose one sentence on the move stays withheld from the asking
// assistant in what is handed over, ahead of the pages that say it. The owner's one tap (and the
// phone push, which releases the first match) gave a page that did not answer. Matches are ordered
// by the text the owner's yes would hand over (G902).
import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { askToSee, askStatus, approveAsk, listAsks } from "../src/asks";
import { addAgent } from "../src/addagent";
import { git } from "../src/git";

async function ask(what: string) {
  const { root } = await makeDemoBrain();
  appendFileSync(join(root, "rules", "policy.yaml"), "\nask_to_see: true\n");
  git(root, ["commit", "-qam", "ask to see on"]);
  addAgent(root, { agent: "notebook", slices: ["area:work"] });
  const r = await askToSee(root, "notebook", { what, why: "plan the week" });
  const a = listAsks(root).find((x) => x.id === r.request)!;
  return { root, a };
}

test("the first match is a page whose handed-over text says what was asked", async () => {
  const { root, a } = await ask("Mom's move in December");
  // The same three pages are offered; only their order follows what would be handed.
  expect(a.candidates.map((c) => c.id).sort()).toEqual(["decisions/2026-09-28-mom-moves-in-december", "people/helene-lefebvre", "projects/moms-move"]);
  expect(a.candidates[0]!.id).not.toBe("people/helene-lefebvre");
  approveAsk(root, a.id, a.candidates[0]!.id);
  const handed = String((await askStatus(root, "notebook", a.id)).note);
  expect(handed.toLowerCase()).toContain("move");
  expect(handed).toContain("December");
}, 60000);

test("the assistant's answer is the same whatever the order, and names no page", async () => {
  const { root } = await makeDemoBrain();
  appendFileSync(join(root, "rules", "policy.yaml"), "\nask_to_see: true\n");
  git(root, ["commit", "-qam", "ask to see on"]);
  addAgent(root, { agent: "notebook", slices: ["area:work"] });
  const hit = await askToSee(root, "notebook", { what: "Mom's move in December", why: "x" });
  const { declineAsk } = await import("../src/asks");
  declineAsk(root, hit.request);
  const miss = await askToSee(root, "notebook", { what: "zebra polo tournament", why: "x" });
  const strip = (m: string, id: string) => m.replaceAll(id, "ID");
  expect(strip(hit.message, hit.request)).toBe(strip(miss.message, miss.request));
  expect(hit.status).toBe(miss.status);
}, 60000);
