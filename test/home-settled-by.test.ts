// SPDX-License-Identifier: AGPL-3.0-only
// The Mac's look at the live canvas, 2026-10-31: two home lines both said "You settled what's next
// for …" with different values, and the owner had settled neither. "You settled" is said only of a
// settle the owner made; an assistant's (a resolver's) names it, and an older row that doesn't say
// who settled it says neither.
import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { homeView } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";

const row = (fact: string, title: string, to: string, at: string, extra: Record<string, unknown>) => JSON.stringify({ at, fact_key: `${fact}#next_step`, title, kind: "settled", from: "freeze the beta build on 15 October", to, source_word: "email", by: "steward", confidence: "stated", rank: 3, sources: 1, sensitivity: "work", undo_token: `t${at.slice(11, 13)}`, settles: "c-x", ...extra });

test("only the owner's own settle says You settled", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    appendFileSync(join(root, "diary/2026-10.jsonl"), [
      row("projects/atlas-launch", "Atlas launch", "freeze on the 22nd", "2026-10-08T13:41:00.000Z", { settled_by: "owner" }),
      row("projects/designer-hire", "Designer hire", "freeze on the 20th", "2026-10-08T13:42:00.000Z", { settled_by: "claude" }),
      row("projects/book-club-november", "Book club November", "freeze on the 18th", "2026-10-08T13:43:00.000Z", {}),
    ].join("\n") + "\n");
    const v = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true });
    const lines = [...v.since, ...v.earlier.flatMap((d) => d.lines)].map((l) => l.what).filter((w) => /settled/i.test(w));
    expect(lines).toContain("You settled what's next for Atlas launch: freeze on the 22nd.");
    expect(lines).toContain("Claude settled what's next for Senior designer hire: freeze on the 20th.");
    expect(lines).toContain("Settled what's next for Book club, November: freeze on the 18th.");
  } finally { delete process.env.PB_NOW; }
}, 60_000);
