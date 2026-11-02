// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-02 (G628): on the settle screen he tapped the calendar's side and the
// page said "no_secret_shapes: contains a card-number-shaped number. Fix: …" at the top. The value
// was a plain sentence; the number was the calendar ref's version (Google's etag, 16 digits, which
// passes Luhn about one time in ten). A source ref's hub-made version is not a secret, and a refusal
// reaches the owner in his words, beside the sides he picks from.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadBrain, type FactRecord } from "../src/brain";
import { inboxConflicts, settleInbox } from "../src/settle-inbox";
import { runChecks } from "../src/checks";
import { settlePage } from "../src/dashboard/html-settle";
import { loadRules } from "../src/rules";

// A 16-digit etag that passes Luhn, made at run time (gitleaks).
function luhnEtag(): string {
  const base = "318116178471200";
  for (let d = 0; d < 10; d++) {
    const s = base + d;
    let sum = 0;
    for (let i = 0; i < s.length; i++) { let n = Number(s[s.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    if (sum % 10 === 0) return s;
  }
  throw new Error("no luhn digit");
}

test("a calendar ref's etag version is not a card number", () => {
  const ref = `gcal:5k2h9q1v7m@${luhnEtag()}`;
  const fails = runChecks({ agent: "capture", id: "projects/x", attribute: "next_step", value: "Book the car seat", as_of: "2026-11-01", sources: [ref] } as never, new Set(["no_secret_shapes"]));
  expect(fails.map((f) => f.check)).toEqual([]);
  // A card number anywhere else in a ref is still refused.
  const card = `4111${"1111".repeat(3)}`;
  expect(runChecks({ agent: "capture", id: "projects/x", attribute: "next_step", value: "x", as_of: "2026-11-01", sources: [`gcal:${card}@1`] } as never, new Set(["no_secret_shapes"])).map((f) => f.check)).toEqual(["no_secret_shapes"]);
});

test("taking the calendar's side of a conflict settles it", () => {
  const root = makeBrain();
  write(root, { agent: "owner", id: "people/jane-roy", attribute: "health_note", value: "x", as_of: "2026-10-07", sources: ["owner:2026-10-07/home"], verification: "confirmed-by-owner", sensitivity: "private" } as never, { owner: true });
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-cal.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "steward", reason: "a page holding a private fact", request: { agent: "steward", kind: "fact", type: "person", title: "Jane Roy", attribute: "role", value: "Dean of studies", as_of: "2026-10-07", sources: [`gcal:5k2h9q1v7m@${luhnEtag()}`], verification: "verified-by-source" } }));
  git(root, ["add", "inbox"]); git(root, ["commit", "-q", "-m", "steward: proposal"]);
  const [c] = inboxConflicts(root);
  expect(c).toBeDefined();
  settleInbox(root, c!.id, { n: 2 });
  expect((loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).value).toBe("Dean of studies");
}, 60_000);

test("a refusal on the settle screen is in the owner's words, beside the sides", () => {
  const root = makeBrain();
  const c = { id: "p-x", fact_key: "people/jane-roy#role", page: "people/jane-roy", title: "Jane Roy", attr: "role", sides: [{ n: 1, value: "Dean", source_word: "email", by: "steward", sources: 1 }, { n: 2, value: "Chair", source_word: "calendar", by: "steward", sources: 1 }] };
  const html = settlePage(c as never, "c", loadRules(root), "no_secret_shapes: contains a card-number-shaped number. Fix: secrets live in your password manager, never in the brain; store where to find it instead");
  expect(html).not.toContain("no_secret_shapes");
  expect(html).toContain("Not saved: looked like a password or card number. It still waits here: pick another side, or tell me what&#39;s right.");
  // Beside the sides: after the last side, before Not sure.
  expect(html.indexOf("Not saved: ")).toBeGreaterThan(html.indexOf("Chair"));
  expect(html.indexOf("Not saved: ")).toBeLessThan(html.indexOf('action="/action/settle-both"'));
});
