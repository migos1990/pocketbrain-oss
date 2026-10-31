// SPDX-License-Identifier: AGPL-3.0-only
// The 390px use-it check of the new home (2026-10-27): an unknown full name with "is a <role>" said
// "I kept nothing" with no way to start the page, and a private page opened right after sign-in
// gave no sign that it would close again.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { loadState } from "../src/dashboard/data";
import { ownerPage, PAGE_COPY } from "../src/dashboard/html-page";

// Since 2026-10-29 (Louis, G474) the page starts in personal at once, with Undo; "is a" says it's a role.
test("an unknown name said with 'is a <role>' starts its page with the role, no questions", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Zed Quorum is a ski instructor");
  expect(r.kind).toBe("say.noted");
  expect(r.undo_token).toBeTruthy();
  const n = loadBrain(root).find((x) => x.fm.title === "Zed Quorum")!;
  expect(n.fm.area).toBe("personal");
  expect(Object.keys(loadRules(root).policy.areas)).toContain("personal");
  expect(String((n.fm.facts!.role as FactRecord).value)).toBe("ski instructor");
});

test("a private page opened by a fresh sign-in says it is private and closes again", () => {
  const root = makeBrain();
  const n = loadBrain(root).find((x) => x.fm.id.startsWith("people/"))!;
  n.fm.sensitivity = "private";
  saveNote(root, n);
  const s = loadState(root, new Date());
  const p = s.notes.find((x) => x.fm.id === n.fm.id)!;
  expect(ownerPage(s, "t", p, [], { fresh: true })).toContain(PAGE_COPY.openPrivate);
  const stale = ownerPage(s, "t", p, []);
  expect(stale).not.toContain(PAGE_COPY.openPrivate);
  expect(stale).toContain(`action="/action/sign-in-again"`);
});

// Two of the home's "slug" lines were dates: a page titled with its day, and a value that is a day.
test("a date reads as the owner says it on the home, as a page name and as a value", async () => {
  const { plain } = await import("../src/dashboard/home");
  const { displayName } = await import("../src/diary");
  expect(displayName("notes/2026-10-12", "2026-10-12")).toBe("12 Oct 2026");
  expect(displayName("notes/2026-10-12")).toBe("12 Oct 2026");
  expect(plain("2026-03-12")).toBe("12 Mar 2026");
  expect(plain("met on 2026-03-12 at noon")).toBe("met on 12 Mar 2026 at noon");
  expect(plain("from 2026-10-01 to 2026-10-12.")).toBe("from 1 Oct 2026 to 12 Oct 2026.");
  expect(plain("ref 12026-03-123 and 2026-13-01 stay")).toBe("ref 12026-03-123 and 2026-13-01 stay");
});

// The last ISO date on the real home sat in a page's name (Mac, 2026-10-27 08:23Z).
test("a day inside a page's name reads as the owner says it", async () => {
  const { displayName } = await import("../src/diary");
  expect(displayName("notes/meeting-2026-10-12", "Meeting 2026-10-12")).toBe("Meeting 12 Oct 2026");
  expect(displayName("notes/meeting-2026-10-12")).toBe("Meeting 12 Oct 2026");
  // a private line names only its page: "Something new about 2026-10-12 call with the dean"
  expect(displayName("notes/x", "2026-10-12 call with the dean")).toBe("12 Oct 2026 call with the dean");
});
