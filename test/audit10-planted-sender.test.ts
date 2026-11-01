// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10 second report, 2026-11-01 (High, G615): an assistant could make any address a known
// sender by writing it on a person page as verified-by-source with a mail ref nobody ever checked.
// G581 closed the card-ref spelling only: trustedAddresses (sameperson.ts) took a source-verified
// record unless one of its refs had been checked and failed. A source-verified address now counts
// only when a ref of it was checked and found (log/refs-checked.jsonl: a pull reads its own items,
// the nightly recheck reads the rest) and none failed; the owner's word counts as before.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { senderStanding } from "../src/sender";
import { recordCheckedRefs } from "../src/louis";
import { loadBrain } from "../src/brain";

const person = (root: string) => loadBrain(root).find((n) => n.fm.type === "person" && n.fm.area === "work")!.fm.id;

test("an address an assistant planted with an unchecked mail ref is not a known sender", () => {
  const root = makeBrain();
  const id = person(root);
  const evil = "planted@evil.example";
  expect(senderStanding(root, evil)).toBe("unknown");
  const r = write(root, { agent: "planner", id, attribute: "email", value: evil, as_of: "2026-10-07", sources: ["gmail:d00000000000e0e1"], verification: "verified-by-source" } as never);
  expect(["committed", "inbox", "disputed"]).toContain(r.outcome);
  expect(senderStanding(root, evil)).toBe("unknown");
  expect(senderStanding(root, `Someone <${evil}>`)).toBe("unknown");
  // Once a pull or the recheck read that mail and found it, the address is known.
  recordCheckedRefs(root, { "gmail:d00000000000e0e1": true });
  if (r.outcome === "committed") expect(senderStanding(root, evil)).toBe("known");
});

test("a ref checked and gone keeps it unknown", () => {
  const root = makeBrain();
  const id = person(root);
  const r = write(root, { agent: "planner", id, attribute: "email", value: "gone@example.net", as_of: "2026-10-07", sources: ["gmail:d00000000000e0e2"], verification: "verified-by-source" } as never);
  expect(r.outcome).toBe("committed");
  recordCheckedRefs(root, { "gmail:d00000000000e0e2": false });
  expect(senderStanding(root, "gone@example.net")).toBe("unknown");
});
