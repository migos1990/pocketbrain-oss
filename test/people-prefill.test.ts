// SPDX-License-Identifier: AGPL-3.0-only
// The people screen pre-fills known and authority from structure only (G865; owner, 2026-11-14:
// every student and every manager had to be set by hand, and Make known recorded no authority
// without saying so). Structure is the owner's own contact card (a typed relation the hub read),
// the owner's own word on his page, and for a class he said he teaches, the people in that class's
// mails as one question. A role word, a job title or a mail-sourced manager fact suggests nothing.
// Nothing applies before the tap, and the tap applies only what the server derives again.
import { test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prefillBrain } from "./people-prefill-fixture";
import { loadBrain } from "../src/brain";
import { write } from "../src/write";
import { git } from "../src/git";
import { loadStanding, setStanding, recordInteraction, suggestStanding, suggestAuthority, classSets, approveSuggestion, approveAuthority, approveStudents, dismissAuthority, bookSet, approveBook } from "../src/standing";
import { peoplePage, standingAction } from "../src/dashboard/people";
import { records } from "../src/carve";
import { prefillBrain as brainWith } from "./people-prefill-fixture";

let root: string;
beforeAll(async () => { root = await prefillBrain(); }, 60_000);

const sug = (id: string) => suggestStanding(root).find((x) => x.person === id);
const idOf = (title: string) => loadBrain(root).find((n) => n.fm.title === title)!.fm.id;

test("the owner's own card naming a manager or an assistant is suggested with its reason", () => {
  const dana = sug(idOf("Dana Okafor"))!, milo = sug(idOf("Milo Hart"))!;
  expect(dana).toMatchObject({ tier: "known", why: "In your address book.", authority: "them", authority_why: "Your contact card lists them as your manager." });
  expect(milo).toMatchObject({ tier: "known", authority: "owner", authority_why: "Your contact card lists them as your assistant." });
});

test("a role word, a title or a mail that says manager suggests no authority (G865)", () => {
  expect(sug("people/sol-vega")?.authority).toBeUndefined();
  expect(sug("people/ike-moss")?.authority).toBeUndefined();
  expect(suggestAuthority(root).map((x) => x.person)).toEqual([]);
});

test("an assistant writing the card's words onto a page suggests nothing", () => {
  const r = write(root, { agent: "claude", id: "people/zed-far", attribute: "relationship", value: "Robin's manager", as_of: "2026-10-06", sources: ["agent:claude/2026-10-06"], verification: "self-reported" } as never);
  expect(["committed", "proposed"]).toContain(r.outcome);
  expect(sug("people/zed-far")?.authority).toBeUndefined();
  expect(suggestAuthority(root).some((x) => x.person === "people/zed-far")).toBe(false);
  expect(bookSet(root)).toEqual([{ id: "people/zed-far", title: "Zed Far" }]);
});

test("the screen shows each reason, never claims 'no authority' it did not derive, and looking changes nothing", () => {
  const before = readFileSync(join(root, "rules", "standing.yaml"), "utf8");
  const notes = loadBrain(root);
  const all = peoplePage({ root, notes } as never, "c").body;
  const html = all.slice(all.indexOf("<h2>Suggested"), all.indexOf("<h2>Your list"));
  expect(sug("people/zed-far")).toBeUndefined(); // no row of his own: one card for the address book
  expect(html).toContain("This person is in your address book. Make them known?");
  expect(html).toContain('name="tick:people/zed-far"');
  expect(html).toContain("Your contact card lists them as your manager.");
  expect(html).toContain("In your address book.");
  expect(html).not.toContain("no authority either way");
  expect(html).toContain("Are they your students?");
  expect(html).not.toContain("suggested: inner");
  expect(readFileSync(join(root, "rules", "standing.yaml"), "utf8")).toBe(before);
});

test("nothing an assistant is told changes before the tap: the standing file who_is reads stays empty", () => {
  suggestStanding(root); suggestAuthority(root); classSets(root);
  expect(loadStanding(root).people).toEqual({});
  expect(git(root, ["status", "--porcelain", "rules"]).trim()).toBe("");
});

test("a class the owner said he teaches is one question over the people in its mails", () => {
  recordInteraction(root, { kind: "gmail", from: "Robin <robin@example.org>", to: "ana@northcollege.example", at: "2026-10-06T12:00:00Z" });
  expect(classSets(root)).toEqual([{ course: "projects/prod-20410", title: "PROD 20410", people: [
    { id: "people/ana-diaz", title: "Ana Diaz", written: true }, { id: "people/ben-roy", title: "Ben Roy", written: false }, { id: "people/cara-lee", title: "Cara Lee", written: false }] }]);
  // Only someone the owner has written to starts ticked: a mail about the class can put a page on
  // the list, never a tick (slice audit of b700082, G825).
  const html = peoplePage({ root, notes: loadBrain(root) } as never, "c").body;
  expect(html).toContain('name="tick:people/ana-diaz" value="1" checked>');
  expect(html).toContain('name="tick:people/ben-roy" value="1"> Ben Roy <span class="sub">(you have not written to them)</span>');
});

test("a tap that differs from what the server derives is refused and writes nothing", () => {
  const dana = idOf("Dana Okafor");
  expect(() => approveSuggestion(root, dana, "known", "owner")).toThrow(/changed since you looked/);
  expect(() => approveSuggestion(root, "people/sol-vega", "known", "them")).toThrow();
  expect(() => approveStudents(root, "projects/prod-20410", ["people/ana-diaz", "people/zed-far"], ["people/zed-far"])).toThrow(/changed since you looked/);
  expect(() => approveStudents(root, "projects/prod-20410", ["people/ana-diaz", "people/ben-roy", "people/cara-lee"], ["people/zed-far"])).toThrow();
  expect(() => approveAuthority(root, "people/ike-moss", "them")).toThrow();
  // A post that leaves the authority out is read as "none was shown", and Dana's was.
  expect(() => standingAction(root, "standing-approve", { person: dana, tier: "known" }, () => dana)).toThrow(/changed since you looked/);
  // The same list in another order is the same list.
  expect(() => approveStudents(root, "projects/prod-20410", ["people/cara-lee", "people/ana-diaz", "people/ben-roy"], ["people/zed-far"])).toThrow(/not on that list/);
  expect(loadStanding(root).people).toEqual({});
});

test("Make it so applies the level and the authority shown, in the owner's commit", () => {
  const dana = idOf("Dana Okafor");
  expect(approveSuggestion(root, dana, "known", "them")).toMatchObject({ tier: "known", authority: "them" });
  expect(git(root, ["log", "-1", "--format=%an"]).trim()).toBe("Robin Lefebvre");
  expect(sug(dana)).toBeUndefined();
});

test("a person already on the list with no authority gets the authority as its own row; one the owner set is left alone", () => {
  const milo = idOf("Milo Hart");
  setStanding(root, milo, "close");
  expect(suggestAuthority(root)).toEqual([{ person: milo, title: "Milo Hart", authority: "owner", why: "Your contact card lists them as your assistant." }]);
  dismissAuthority(root, milo, "owner");
  expect(suggestAuthority(root)).toEqual([]);
  setStanding(root, milo, "close", { authority: "them" });
  expect(suggestAuthority(root)).toEqual([]);
});

test("ticked people become known under the owner's authority; an unticked one is not asked about again", () => {
  const shown = ["people/ana-diaz", "people/ben-roy", "people/cara-lee"];
  setStanding(root, "people/ben-roy", "close");
  approveStudents(root, "projects/prod-20410", shown, ["people/ana-diaz", "people/ben-roy"]);
  const p = loadStanding(root).people;
  expect(p["people/ana-diaz"]).toMatchObject({ tier: "known", authority: "owner" });
  expect(p["people/ben-roy"]).toMatchObject({ tier: "close", authority: "owner" }); // never lowered
  expect(p["people/cara-lee"]).toBeUndefined();
  expect(classSets(root)).toEqual([]);
});

test("the rest of the address book is one card: a list that moved is refused, ticked people become known, unticked are left out", () => {
  expect(() => approveBook(root, ["people/zed-far", "people/sol-vega"], ["people/sol-vega"])).toThrow(/changed since you looked/);
  expect(() => approveBook(root, ["people/zed-far"], ["people/sol-vega"])).toThrow();
  expect(loadStanding(root).people["people/sol-vega"]).toBeUndefined();
  expect(approveBook(root, ["people/zed-far"], ["people/zed-far"])).toEqual(["people/zed-far"]);
  expect(loadStanding(root).people["people/zed-far"]).toMatchObject({ tier: "known" });
  expect(loadStanding(root).people["people/zed-far"]!.authority).toBeUndefined();
  expect(bookSet(root)).toEqual([]);
});

// Slice audit of b700082 (G824): where the brain's resolver is an assistant, the cards file as
// that assistant, so its own write citing the owner's real card looked like the card.
test("a resolver assistant borrowing the owner's card ref for its own words suggests nothing", async () => {
  const r = await brainWith({ resolver: "claude" });
  const notes = loadBrain(r);
  const dana = notes.find((n) => n.fm.title === "Dana Okafor")!;
  const ref = records(dana.fm.facts!.relationship!).flatMap((x) => (x.sources ?? []).map(String)).find((x) => x.startsWith("contacts:"))!;
  expect(ref).toContain("robin-me");
  const w = write(r, { agent: "claude", id: "people/zed-far", attribute: "relationship", value: "Robin's manager", as_of: "2026-10-06", sources: [ref], verification: "self-reported" } as never);
  expect(w.outcome).toBe("committed");
  const zed = suggestStanding(r).find((x) => x.person === "people/zed-far");
  expect(zed?.authority).toBeUndefined();
  setStanding(r, "people/zed-far", "known");
  expect(suggestAuthority(r).map((x) => x.person)).toEqual([]);
  // The card's own reading still counts on this brain.
  expect(suggestStanding(r).find((x) => x.person === dana.fm.id)).toMatchObject({ authority: "them" });
}, 60_000);
