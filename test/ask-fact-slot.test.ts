// SPDX-License-Identifier: AGPL-3.0-only
// The LinkedIn filming, 2026-11-07 (G706): on the demo brain, Ask's "When do we freeze the Atlas
// beta?" got "Nothing on that yet" though the Atlas launch page holds the next step, and "What's
// next for Atlas launch?" got the whole page's prose. A question is matched to the fact it asks
// about and answered with that fact and its source: not nothing, and not everything.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { loadState } from "../src/dashboard/data";
import { askFact } from "../src/dashboard/html-page";

test("a question about one fact of a page is answered with that fact, by the page's short name too", async () => {
  const { root } = await makeDemoBrain();
  const freeze = ownerSay(root, "When do we freeze the Atlas beta?", { from: "ask" });
  expect(freeze).toMatchObject({ kind: "say.answer", page: "projects/atlas-launch", fact_key: "projects/atlas-launch#next_step" });
  expect(freeze.text).toBe("Atlas launch's next step is to freeze the beta build on 15 October.");
  const next = ownerSay(root, "What's next for Atlas launch?", { from: "ask" });
  expect(next).toMatchObject({ kind: "say.answer", fact_key: "projects/atlas-launch#next_step" });
  expect(next.text.length).toBeLessThan(120);
  // A question that asks about the page as a whole still gets the page.
  expect(ownerSay(root, "What is Atlas launch?", { from: "ask" }).kind).toBe("say.lookup");
}, 60_000);

test("the answer cites the fact's page and where it came from", async () => {
  const { root } = await makeDemoBrain();
  const s = loadState(root);
  const n = s.notes.find((x) => x.fm.id === "projects/atlas-launch")!;
  const a = askFact(s, n, "next_step", "Atlas launch's next step is to freeze the beta build on 15 October.", false)!;
  expect(a.cites[0]).toEqual({ href: "/p/projects/atlas-launch", label: "Atlas launch" });
  expect(a.cites.map((c) => c.label).join(" ")).toMatch(/From an email, Oct 7/);
}, 60_000);
