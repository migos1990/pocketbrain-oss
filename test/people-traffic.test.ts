// SPDX-License-Identifier: AGPL-3.0-only
// Who matters pre-fills from what a mail-and-calendar brain holds (G829; owner, 2026-11-14: the
// list "could prob be pre filled based on the data u have and pure logic", and on a brain with no
// address book the screen showed nothing). Evidence is structure only: mail both ways with an
// address the owner writes to (tied to a page by the address on it, or by the name his own mail
// client put on the To line), meetings he organized or accepted, and facts in his own word. Known
// at most, never authority, nothing before the tap, and a sender's own display name ties nothing.
import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { git } from "../src/git";
import * as core from "../src/core";
import { loadStanding, recordInteraction, suggestStanding, approveSuggestion, toldSet, approveTold, mailWithoutSent } from "../src/standing";
import { saveUpcoming, toUpcoming } from "../src/upcoming";
import { peoplePage } from "../src/dashboard/people";
import { forgetPerson } from "../src/forget";
import { DEMO_DAY } from "../scripts/demo-brain";

let root: string;
const ME = "Robin Lefebvre <robin@example.org>";
const sug = (id: string, r = root) => suggestStanding(r).find((x) => x.person === id);
let hour = 0;
const at = () => new Date(Date.UTC(2026, 8, 1) + hour++ * 3600e3).toISOString(); // each mail an hour after the last
const sent = (to: string, n = 1, r = root) => { for (let i = 0; i < n; i++) recordInteraction(r, { kind: "gmail", from: ME, to, at: at(), sent: true }); };
const got = (from: string, n = 1, r = root, when?: string) => { for (let i = 0; i < n; i++) recordInteraction(r, { kind: "gmail", from, to: ME, at: when ?? at(), sent: false }); };
const page = (r: string, id: string, title: string, facts = "", o: { sensitivity?: string } = {}) => {
  mkdirSync(join(r, "people"), { recursive: true });
  writeFileSync(join(r, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: "${title}"\narea: work\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n${facts ? `facts:\n${facts}` : ""}---\n`);
};
const own = (attr: string, value: string, day: string) => `  ${attr}: { value: "${value}", as_of: ${day}, sources: ["owner:${day}/notes"], verification: confirmed-by-owner, by: owner, recorded: ${day} }\n`;
const commit = (r: string) => { git(r, ["add", "-A"]); git(r, ["commit", "-qm", "owner: test pages"], "owner"); };
type Ev = { id: string; day: string; guests: { email: string; displayName?: string }[]; mine?: "organizer" | "accepted" | "none" };
const events = (r: string, evs: Ev[]) => saveUpcoming(r, "calendar", evs.flatMap((e) => toUpcoming({ id: e.id, etag: `"1"`, summary: `Sync ${e.id}`, start: { dateTime: `${e.day}T14:00:00Z` },
  ...(e.mine === "none" ? {} : (e.mine ?? "organizer") === "organizer" ? { organizer: { email: "robin@example.org", self: true } } : {}),
  attendees: [{ email: "robin@example.org", self: true, responseStatus: e.mine === "none" ? "needsAction" : "accepted" }, ...e.guests] }, "calendar") ?? []), DEMO_DAY);

beforeAll(async () => {
  root = (await makeDemoBrain()).root;
  page(root, "people/ivo-brandt", "Ivo Brandt");
  page(root, "people/una-keller", "Una Keller");
  page(root, "people/otto-renn", "Otto Renn");
  page(root, "people/pia-sand", "Pia Sand");
  page(root, "people/sam-twin", "Sam Twin");
  page(root, "people/sam-twin-2", "Sam Twin");
  page(root, "people/vera-holt", "Vera Holt", "", { sensitivity: "private" });
  page(root, "people/told-three", "Tessa Told", own("role", "architect", "2026-10-01") + own("city", "Lyon", "2026-10-01") + own("prefers", "calls before noon", "2026-10-03") + own("school", "Lyon 2", "2026-10-03") + own("languages", "French and German", "2026-10-03") + own("hobby", "rowing", "2026-10-03"));
  page(root, "people/told-two", "Timo Told", own("role", "designer", "2026-10-01") + own("city", "Lille", "2026-10-03"));
  page(root, "people/told-one-day", "Tara Told", own("role", "editor", "2026-10-01") + own("city", "Nice", "2026-10-01") + own("prefers", "mail", "2026-10-01"));
  commit(root);
}, 60_000);

test("mail both ways with a name his own To line gives is suggested known, with its reason and no address on the page", () => {
  sent("Ivo Brandt <ivo@brandt.example>", 2); got("Ivo B <ivo@brandt.example>", 2);
  const s = sug("people/ivo-brandt")!;
  expect(s).toMatchObject({ tier: "known", why: "You write to each other: 2 from them, 2 from you.", via: [{ address: "ivo@brandt.example", confirmed: false, by_name: true }] });
  // The card shows the address it matched, so the owner can judge it.
  expect(peoplePage({ root, notes: loadBrain(root) } as never, "c").body).toContain("ivo@brandt.example</b> <span class=\"sub\">(matched by the name on mail you sent; it is not on their page)");
  expect(s.authority).toBeUndefined();
  expect(loadBrain(root).find((n) => n.fm.id === "people/ivo-brandt")!.fm.facts).toBeUndefined();
});

test("under the bar there is no card: one mail from him, or none back", () => {
  sent("Una Keller <una@keller.example>", 1); got("una@keller.example", 5);
  expect(sug("people/una-keller")).toBeUndefined();
  sent("Pia Sand <pia@sand.example>", 4);
  expect(sug("people/pia-sand")).toBeUndefined();
});

test("a sender's own display name ties nothing, at any count, and never once he answers a bare address", () => {
  got("Otto Renn <stranger@elsewhere.example>", 12);
  expect(sug("people/otto-renn")).toBeUndefined();
  sent("stranger@elsewhere.example", 3);
  expect(sug("people/otto-renn")).toBeUndefined();
});

test("a first.last address ties only when the To line gave no other name, and one page fits", () => {
  const a = (await0()).root;
  page(a, "people/otto-renn", "Otto Renn"); commit(a);
  sent("otto.renn@renn.example", 2, a); got("otto.renn@renn.example", 2, a);
  expect(sug("people/otto-renn", a)).toMatchObject({ tier: "known" });
  const b = (await0()).root;
  page(b, "people/otto-renn", "Otto Renn"); commit(b);
  sent("Someone Else <otto.renn@renn.example>", 2, b); got("otto.renn@renn.example", 2, b);
  expect(sug("people/otto-renn", b)).toBeUndefined();
});

test("a name two pages share gives no card", () => {
  sent("Sam Twin <sam@twin.example>", 3); got("sam@twin.example", 3);
  expect(sug("people/sam-twin")).toBeUndefined();
  expect(sug("people/sam-twin-2")).toBeUndefined();
});

test("a private page gets no card from this evidence", () => {
  sent("Vera Holt <vera@holt.example>", 3); got("vera@holt.example", 3);
  expect(sug("people/vera-holt")).toBeUndefined();
});

test("standing reads an address only from an address attribute: someone else's address on a page is never that person's (audit F1)", () => {
  const r = made.pop()!.root;
  page(r, "people/wes-moss", "Wes Moss", `  assistant_email: { value: "aide@moss.example", as_of: 2026-10-01, sources: ["owner:2026-10-01/notes"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n`);
  commit(r);
  sent("aide@moss.example", 3, r); got("aide@moss.example", 3, r);
  expect(sug("people/wes-moss", r)).toBeUndefined();
  expect(core.whoIs(r, "claude", "aide@moss.example").standing.tier).toBe("unknown");
});

test("the name on a reply is the sender's own choice: it ties nothing once that address wrote first (audit F2)", () => {
  got("Otto Renn <impostor@elsewhere.example>", 2);
  sent("Otto Renn <impostor@elsewhere.example>", 3);
  expect(sug("people/otto-renn")).toBeUndefined();
  // A quoted comma in a To name is one name, not two entries.
  sent(`"x, Otto Renn" <other@elsewhere.example>`, 3); got("other@elsewhere.example", 2);
  expect(sug("people/otto-renn")).toBeUndefined();
});

test("his own address is never a contact, with no me list in rules", () => {
  sent("Ivo Brandt <ivo@brandt.example>, Robin Lefebvre <robin@example.org>", 4);
  const c = JSON.parse(readFileSync(join(root, "log", "standing", "contacts.json"), "utf8"));
  expect(Object.keys(c)).not.toContain("robin@example.org");
  expect(loadStanding(root).me ?? []).toEqual([]);
});

test("meetings he organized or accepted, three on three days with a page's address, suggest known", () => {
  const ben = { email: "ben.carter@example.org" }, maya = { email: "maya.chen@example.org" }, grace = { email: "grace.liu@example.org" }, priya = { email: "priya.shah@example.org" };
  const crowd = Array.from({ length: 9 }, (_, i) => ({ email: `guest${i}@crowd.example` }));
  events(root, [
    { id: "a1", day: "2026-09-22", guests: [ben] }, { id: "a2", day: "2026-09-29", guests: [ben], mine: "accepted" }, { id: "a3", day: "2026-10-06", guests: [ben] },
    { id: "b1", day: "2026-09-22", guests: [maya] }, { id: "b2", day: "2026-09-29", guests: [maya] },                       // two days only
    { id: "c1", day: "2026-09-22", guests: [grace], mine: "none" }, { id: "c2", day: "2026-09-29", guests: [grace], mine: "none" }, { id: "c3", day: "2026-10-06", guests: [grace], mine: "none" }, // invites he never answered
    { id: "d1", day: "2026-09-22", guests: [priya, ...crowd] }, { id: "d2", day: "2026-09-29", guests: [priya, ...crowd] }, { id: "d3", day: "2026-10-06", guests: [priya, ...crowd] }, // big meetings
  ]);
  expect(sug("people/ben-carter")).toMatchObject({ tier: "known", why: "You met 3 times since September." });
  for (const id of ["people/maya-chen", "people/grace-liu", "people/priya-shah"]) expect(sug(id)).toBeUndefined();
  // A meeting still to come is not a meeting he had.
  events(root, [{ id: "a1", day: "2026-09-22", guests: [ben] }, { id: "a2", day: "2026-09-29", guests: [ben] }, { id: "a9", day: "2026-10-20", guests: [ben] }]);
  expect(sug("people/ben-carter")).toBeUndefined();
  events(root, [{ id: "a1", day: "2026-09-22", guests: [ben] }, { id: "a2", day: "2026-09-29", guests: [ben], mine: "accepted" }, { id: "a3", day: "2026-10-06", guests: [ben] }]);
});

test("a guest's name on an invite ties nothing: the calendar row needs the page's own address", () => {
  const ben = { email: "ben.carter@example.org" };
  events(root, [...[1, 2, 3].map((i) => ({ id: `n${i}`, day: `2026-09-2${i}`, guests: [{ email: "x@elsewhere.example", displayName: "Otto Renn" }] })),
    { id: "a1", day: "2026-09-22", guests: [ben] }, { id: "a2", day: "2026-09-29", guests: [ben], mine: "accepted" as const }, { id: "a3", day: "2026-10-06", guests: [ben] }]);
  expect(sug("people/otto-renn")).toBeUndefined();
});

test("facts in his own word (three or more, from two days) put a person on one grouped question, unticked; two facts, or one day, do not", () => {
  const told = toldSet(root);
  expect(told.find((p) => p.id === "people/told-three")).toEqual({ id: "people/told-three", title: "Tessa Told", times: 6 });
  expect(told.some((p) => ["people/told-two", "people/told-one-day", "people/vera-holt"].includes(p.id))).toBe(false);
  expect(sug("people/told-three")).toBeUndefined();
  const html = peoplePage({ root, notes: loadBrain(root) } as never, "c").body;
  expect(html).toContain('name="tick:people/told-three" value="1"> Tessa Told');
  expect(html).not.toContain('name="tick:people/told-three" value="1" checked');
});

test("never authority, never above known from this evidence, and nothing changes before the tap", () => {
  for (const id of ["people/ivo-brandt", "people/ben-carter"]) {
    const s = sug(id)!;
    expect(s.tier).toBe("known"); expect(s.authority).toBeUndefined();
  }
  expect(loadStanding(root).people).toEqual({});
  expect(git(root, ["status", "--porcelain", "rules"]).trim()).toBe("");
});

test("who_is answers the same before and after the tap for an address that is on no page", () => {
  const ask = () => core.whoIs(root, "claude", "ivo@brandt.example");
  const before = ask();
  expect(before.standing.tier).toBe("unknown");
  approveSuggestion(root, "people/ivo-brandt", "known", "none");
  expect(loadStanding(root).people["people/ivo-brandt"]).toMatchObject({ tier: "known" });
  expect(loadStanding(root).people["people/ivo-brandt"]!.addresses ?? []).toEqual([]);
  expect(ask()).toEqual(before);
});

test("the screen shows each reason, and a tap for what the server does not derive is refused", () => {
  const html = peoplePage({ root, notes: loadBrain(root) } as never, "c").body;
  expect(html).toContain("You met 3 times since September.");
  expect(() => approveSuggestion(root, "people/ben-carter", "close", "none")).toThrow(/changed/);
  expect(() => approveSuggestion(root, "people/ben-carter", "known", "them")).toThrow(/changed/);
  const shown = toldSet(root).map((p) => p.id);
  expect(() => approveTold(root, shown.slice(1), ["people/told-three"])).toThrow(/changed/);
  expect(() => approveTold(root, shown, ["people/ivo-brandt"])).toThrow(/not on that list/);
  expect(approveTold(root, shown, ["people/told-three"])).toEqual(["people/told-three"]);
  expect(loadStanding(root).people["people/told-three"]).toMatchObject({ tier: "known" });
  expect(toldSet(root).some((p) => shown.includes(p.id))).toBe(false);
});

test("the grouped question shows ten people at most, the ones he said most about first", () => {
  const r = made.pop()!.root;
  const told = toldSet(r);
  expect(told.length).toBe(10);
  expect(told.map((p) => p.times)).toEqual([...told.map((p) => p.times)].sort((a, b) => b - a));
});

test("forgetting a person drops the traffic counted under their name", () => {
  sent("Pia Sand <pia@sand.example>", 1); got("pia@sand.example", 2);
  expect(sug("people/pia-sand")).toBeDefined();
  forgetPerson(root, "people/pia-sand", { now: Date.parse(`${DEMO_DAY}T12:00:00Z`) });
  const f = join(root, "log", "standing", "contacts.json");
  expect(existsSync(f) && readFileSync(f, "utf8")).not.toContain("pia@sand.example");
});

test("a mail source that leaves out sent mail is named, so thin suggestions have a stated cause", () => {
  const f = join(root, "rules", "sources.yaml"), was = readFileSync(f, "utf8");
  expect(mailWithoutSent(root)).toEqual([]);
  writeFileSync(f, was.replace(/kind: gmail/, "kind: gmail\n    where: [INBOX]"));
  const names = mailWithoutSent(root);
  expect(names.length).toBe(1);
  expect(peoplePage({ root, notes: loadBrain(root) } as never, "c").body).toContain("reads your inbox but not the mail you send");
  writeFileSync(f, was.replace(/kind: gmail/, "kind: gmail\n    where: [INBOX, SENT]"));
  expect(mailWithoutSent(root)).toEqual([]);
  writeFileSync(f, was);
});

async function fresh() { const r = (await makeDemoBrain()).root; return { root: r }; }
const made: { root: string }[] = [];
beforeAll(async () => { made.push(await fresh(), await fresh(), await fresh(), await fresh(), await fresh(), await fresh()); }, 60_000);
function await0() { return made.pop()!; }

test("count_sent counts recipients from sent-mail headers once, files nothing, and the setter writes one owner commit", async () => {
  const r = made.pop()!.root;
  page(r, "people/ivo-brandt", "Ivo Brandt"); commit(r);
  const { setCountSent } = await import("../src/ownerset");
  const { pullSource } = await import("../src/pull");
  expect(() => setCountSent(r, "nope", "on")).toThrow(/not a Gmail source/);
  expect(() => setCountSent(r, "mail", "on", 0)).toThrow(/--days/);
  const src = join(r, "rules", "sources.yaml");
  writeFileSync(src, readFileSync(src, "utf8").replace(/kind: gmail/, "kind: gmail\n    where: [INBOX]")); commit(r);
  setCountSent(r, "mail", "on", 30);
  expect(readFileSync(join(r, "rules", "sources.yaml"), "utf8")).toContain("count_sent: 30");
  expect(git(r, ["log", "-1", "--format=%an"]).trim()).toBe("Robin Lefebvre");
  const rows = [1, 2, 3].map((i) => ({ id: `s${i}`, to: "Ivo Brandt <ivo@brandt.example>, robin@example.org", at: `2026-10-0${i}T09:00:00Z` }));
  const cursors: (string | undefined)[] = [];
  const before = { notes: loadBrain(r).length, captures: git(r, ["status", "--porcelain", "inbox", "people", "log/refs-checked.jsonl"]).trim() };
  const pull = () => pullSource(r, "mail", { fetch: () => ({ items: [], cursor: "1" }), sent: (_c, cursor) => { cursors.push(cursor); return rows; }, model: null });
  await pull(); await pull();
  const c = JSON.parse(readFileSync(join(r, "log", "standing", "contacts.json"), "utf8"));
  expect(c["ivo@brandt.example"]).toMatchObject({ in: 0, out: 3 });
  expect(Object.keys(c)).not.toContain("robin@example.org");
  expect(cursors).toEqual([undefined, "2026-10-03T09:00:00Z"]);
  expect(loadBrain(r).length).toBe(before.notes);
  expect(git(r, ["status", "--porcelain", "inbox", "people", "log/refs-checked.jsonl"]).trim()).toBe(before.captures);
  got("ivo@brandt.example", 1, r, "2026-10-04T09:00:00Z");
  expect(sug("people/ivo-brandt", r)).toMatchObject({ tier: "known", why: "You write to each other: 1 from them, 3 from you." });
  setCountSent(r, "mail", "off");
  expect(readFileSync(join(r, "rules", "sources.yaml"), "utf8")).not.toContain("count_sent");
});

test("count_sent stands down where the pull already reads sent mail: no where list, or one with SENT (audit F3)", async () => {
  const r = made.pop()!.root;
  const { setCountSent } = await import("../src/ownerset");
  const { pullSource } = await import("../src/pull");
  setCountSent(r, "mail", "on", 30);
  let asked = 0;
  await pullSource(r, "mail", { fetch: () => ({ items: [], cursor: "1" }), sent: () => { asked++; return []; }, model: null });
  expect(asked).toBe(0); // the demo source has no where list: its pull reads every label
  const f = join(r, "rules", "sources.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/kind: gmail/, "kind: gmail\n    where: [INBOX]"));
  await pullSource(r, "mail", { fetch: () => ({ items: [], cursor: "1" }), sent: () => { asked++; return []; }, model: null });
  expect(asked).toBe(1);
});
