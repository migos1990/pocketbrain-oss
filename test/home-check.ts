// SPDX-License-Identifier: AGPL-3.0-only
// The Home property's run and its statements (G987; docs/owner-home.md "Home as a property").
// One made-up week (test/home-gen.ts) is pulled and filed day by day on a fresh brain with the
// shipped default rules, the owner answers what the week says they answer, and then the owner's
// home is read as the owner would see it. The statements are written here from the week the
// generator made and from what the screens say, apart from the code that decides what asks:
//   1. every question the home asks is about a fact two people gave two values for that week;
//   2. each such fact is asked once, and nothing else waits on the owner;
//   3. a question shows two or more sides, each with a value, no two the same value in another spelling;
//   4. no side is a value only a machine's mail gave, and no voucher code is on the home or a settle screen;
//   5. a question the owner answered is gone, stays gone when the hub reads the same mail again,
//      and is not asked again when the same sender says the same thing the day after;
//   6. each question is said in plain words: its page's name, no source ref, id, path or field name;
//   7. two different next steps two people gave for one project the same day are never a question,
//      and the project's page holds both.
// It reads; it never changes what counts as an ask.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { initBrain } from "../src/init";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { renderTouchedPages } from "../src/wiki";
import { ownerConflicts, ownerDecide, ownerKeepBoth, type SettleCase } from "../src/core";
import { inboxConflicts, settleInbox } from "../src/settle-inbox";
import { ownerAsks } from "../src/waiting";
import { homeWaiting, homeView } from "../src/dashboard/home";
import { homePage } from "../src/dashboard/html-app";
import { settlePage } from "../src/dashboard/html-settle";
import { asked, careless, senderOf, slug, type Week, type Mail, type Case } from "./home-gen";

export interface Finding { statement: number; what: string }
export interface Run { findings: Finding[]; asks: number; answered: number; mails: number }

const START = Date.parse("2026-09-07T09:00:00Z");
const at = (day: number, minute: number) => new Date(START + day * 86_400_000 + minute * 60_000);
const hex = (n: number) => n.toString(16).padStart(16, "0");

// A value as a person compares it: case, spacing and punctuation aside.
export const fold = (v: unknown) => String(typeof v === "string" ? v : JSON.stringify(v)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// What a screen says: its text without styles, scripts and tags.
export const shown = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
// Text no owner should have to read: a source ref, a long id, a field name, a path, a link's brackets, a program's empty word.
const MACHINE_TEXT: [RegExp, string][] = [
  [/\b(?:gmail|mail|gcal|agent|owner|capture|drive|slack):[^\s,;]{4,}/, "a source ref"],
  [/\b[0-9a-f]{12,}\b/, "a long id"],
  [/\b[a-z]+_[a-z_]+\b/, "a field name"],
  [/\b(?:people|projects|orgs|disputes|inbox)\/[a-z0-9-]+/, "a page path"],
  [/\[\[|\]\]/, "a link's brackets"],
  [/\b(?:undefined|null|NaN)\b|\[object /, "a program's empty word"],
];
export const notPlain = (text: string) => MACHINE_TEXT.find(([re]) => re.test(text))?.[1];

const every = (root: string, later: Date): SettleCase[] => [...ownerConflicts(root, later, { held: true }), ...inboxConflicts(root)];
const keyOfCase = (c: SettleCase) => `${c.page}#${c.attr}`;

export async function runWeek(w: Week): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "pb-home-week-"));
  const env = { PB_TODAY: process.env.PB_TODAY, PB_NOW: process.env.PB_NOW };
  const out: Finding[] = [];
  const find = (statement: number, what: string) => { if (!out.some((f) => f.what === what)) out.push({ statement, what }); };
  let answered = 0;
  try {
    initBrain(root, { owner: w.owner.name, me: [w.owner.address], token: false });
    // The mail stays outside the brain. Every other week the source reads machine mail too.
    const fixture = join(mkdtempSync(join(tmpdir(), "pb-home-mail-")), "week.json");
    writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "home property", sources: { mail: { kind: "gmail", area: "work", fixture, ...(w.seed % 2 ? { skip_bulk: false } : {}) } } }));
    mkdirSync(join(root, "people"), { recursive: true });
    w.people.forEach((p, k) => writeFileSync(join(root, "people", `${slug(p)}.md`), `---\nid: people/${slug(p)}\ntype: person\ntitle: ${p}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-01\nby: owner\nfacts:\n  email: { value: "${senderOf(k)}", as_of: 2026-09-01, sources: ["owner:2026-09-01/setup"], verification: confirmed-by-owner, by: owner, recorded: 2026-09-01 }\n---\n`));
    Bun.spawnSync(["git", "-C", root, "add", "rules", "people"]); Bun.spawnSync(["git", "-C", root, "commit", "-qm", "owner: the week's setup", "--", "rules", "people"]);

    const all: Mail[] = w.cases.flatMap((c) => [...c.mails, ...(c.again ? [c.again] : [])]);
    const sent: Mail[] = [], items: Record<string, unknown>[] = [];
    const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => careless(w, sent)(r.prompt) });
    const day = async (d: number) => {
      for (const m of all.filter((x) => x.day === d)) {
        sent.push(m);
        items.push({ id: hex(0xb000 + m.minute), threadId: hex(0xb000 + m.minute), internalDate: String(at(d, 10 + m.minute).getTime()), labelIds: ["INBOX"],
          payload: { headers: [{ name: "From", value: m.from === "machine" ? `Notices <${senderOf(m.from)}>` : `${w.people[m.from]} <${senderOf(m.from)}>` }, { name: "To", value: w.owner.address }, { name: "Subject", value: `${m.entity} news` }] },
          text: `Hello ${w.owner.name.split(" ")[0]}, one thing for your notes. ${m.sentence}. All the best.` });
      }
      writeFileSync(fixture, JSON.stringify(items));
      const now = at(d, 700);
      process.env.PB_TODAY = now.toISOString().slice(0, 10); process.env.PB_NOW = now.toISOString();
      await pullSource(root, "mail", { model });
      runAuto(root, now);
      renderTouchedPages(root, new Date(now.getTime() - 86_400_000).toISOString());
      return now;
    };
    for (let d = 1; d <= 5; d++) await day(d);

    // Day 6: the owner answers what the week says they answer, on the screen's own functions.
    const six = at(6, 600);
    process.env.PB_TODAY = six.toISOString().slice(0, 10); process.env.PB_NOW = six.toISOString();
    for (const c of w.cases.filter((x) => x.kind === "answered")) {
      const open = every(root, six).filter((x) => keyOfCase(x) === c.key);
      if (open.length !== 1) { find(2, `a fact two people gave two values for was asked ${open.length} times before its answer (${c.attribute})`); continue; }
      const q = open[0]!, inbox = q.id.startsWith("p-");
      const side = (v: string) => q.sides.find((s) => fold(s.value) === fold(v))?.n;
      const n = c.answer === "first" ? side(c.mails[0]!.value) : c.answer === "second" ? side(c.mails[1]!.value) : undefined;
      try {
        if (c.answer === "both") inbox ? settleInbox(root, q.id, { n: 1 }) : ownerKeepBoth(root, q.id);
        else if (c.answer === "typed") inbox ? settleInbox(root, q.id, { typed: c.typed! }) : ownerDecide(root, q.id, c.typed!, `settle-${q.id}`, { typed: true });
        else if (n === undefined) { find(3, `a question did not show one of the two values the mails gave (${c.attribute})`); continue; }
        else inbox ? settleInbox(root, q.id, { n }) : ownerDecide(root, q.id, n, `settle-${q.id}`);
        answered++;
      } catch (e) { find(5, `the owner's answer (${c.answer}) was refused: ${String((e as Error).message).replace(/["“][^"”]*["”]/g, "…").slice(0, 80)}`); continue; }
      if (every(root, six).some((x) => keyOfCase(x) === c.key)) find(5, `a question the owner answered (${c.answer}) was still asked right after`);
    }
    runAuto(root, six);
    // Day 7: some senders say their value again. Day 8: the hub reads the same mail once more.
    await day(7);
    const first = (r: string, later: Date) => every(r, later).map(keyOfCase).sort().join("\n");
    const eight = at(8, 600), later = new Date(at(8, 900).getTime() + 36 * 3_600_000);
    const before = first(root, later);
    process.env.PB_TODAY = eight.toISOString().slice(0, 10); process.env.PB_NOW = eight.toISOString();
    await pullSource(root, "mail", { model });
    runAuto(root, eight);
    renderTouchedPages(root, new Date(eight.getTime() - 86_400_000).toISOString());
    if (first(root, later) !== before) find(5, "what the home asks changed when the hub read the same mail again");

    // The home, a day and a half on (so nothing is still held for the night pass).
    const end = at(8, 900);
    process.env.PB_NOW = end.toISOString();
    const rules = loadRules(root), notes = loadBrain(root);
    const cases = every(root, later), cards = homeWaiting(root, later), asks = ownerAsks(root, end, later);
    const want = asked(w), byKey = new Map<string, Case>(w.cases.map((c) => [c.key, c]));
    // 1 and 5: only the week's open clashes ask.
    for (const c of cases) {
      const k = keyOfCase(c), from = byKey.get(k);
      if (want.includes(k)) continue;
      if (from?.kind === "steps") find(7, "the home asks the owner to pick between two next steps two people gave the same day");
      else if (from?.kind === "answered") find(5, `a question the owner answered (${from.answer}) is asked again${from.again ? " after the same sender said the same thing the day after" : ""}`);
      else find(1, `the home asks about a fact nobody contradicted (${from ? `case: ${from.kind}` : "no case of the week"}, ${c.attr})`);
    }
    // 7: both steps are on the project's page, side by side.
    for (const c of w.cases.filter((x) => x.kind === "steps")) {
      const held = fold(JSON.stringify(notes.find((n) => n.fm.id === c.key.split("#")[0])?.fm.facts?.[c.attribute] ?? ""));
      const n = (c.both ?? []).filter((v) => held.includes(fold(v))).length;
      if (n !== (c.both ?? []).length) find(7, `a project two people gave two next steps for the same day holds ${n} of them`);
    }
    // 2: each once, and nothing else waits.
    for (const k of want) { const n = cases.filter((c) => keyOfCase(c) === k).length; if (n !== 1) { const of = cases.filter((c) => keyOfCase(c) === k); find(2, `a fact two people gave two values for is asked ${n} times (${k.split("#")[1]}, case: ${byKey.get(k)?.kind}; ${of.filter((c) => !c.id.startsWith("p-")).length} as a conflict, ${of.filter((c) => c.id.startsWith("p-")).length} as a change that waits; sides ${of.map((c) => c.sides.length).join(" and ")})`); if (process.env.HOME_KEEP) console.log("DETAIL", JSON.stringify(of.map((c) => ({ id: c.id, sides: c.sides.map((x) => [x.value, x.refs, x.as_of]) })))); } }
    const settle = cards.filter((c) => c.href.startsWith("/settle/")), other = cards.filter((c) => !c.href.startsWith("/settle/") && (c.n ?? 1) > 0);
    for (const c of other) find(2, `the home lists something that is no conflict (${c.verb})`);
    if (asks.total !== cases.length) find(2, `the count of what waits on the owner (${asks.total}) is not the number of questions (${cases.length}); by kind: ${Object.entries(asks.by).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    if (settle.reduce((a, c) => a + (c.n ?? 1), 0) !== cases.length) find(2, `the home's cards count ${settle.reduce((a, c) => a + (c.n ?? 1), 0)} questions for ${cases.length} open ones`);
    // 3 and 4: sides a person could choose between.
    // A machine's value is its own fact's: another fact may hold the same words from a person.
    const machineOf = (k: string) => { const c = byKey.get(k); return c?.kind === "machine" ? c.never ?? [] : []; };
    const codes = w.cases.filter((c) => c.kind === "code").flatMap((c) => c.never ?? []);
    const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (const c of cases) {
      const sides = byKey.get(keyOfCase(c))?.sides ?? 2;
      if (c.sides.length !== sides && want.includes(keyOfCase(c))) find(3, `a question about ${sides} different values shows ${c.sides.length} side(s) (${c.attr})`);
      if (c.sides.length < 2) find(3, `a question shows ${c.sides.length} side(s) (${c.attr})`);
      if (c.sides.some((s) => !fold(s.value))) find(3, `a question shows a side with no value (${c.attr})`);
      if (new Set(c.sides.map((s) => fold(s.value))).size !== c.sides.length) find(3, `a question shows the same value twice in two spellings (${c.attr})`);
      const machine = machineOf(keyOfCase(c));
      if (c.sides.some((s) => machine.some((v) => fold(s.value) === fold(v)))) find(4, `a side of a question is a value only a machine's mail gave (${c.attr})`);
      // 6: its screen, as the owner reads it right after signing in.
      const page = shown(settlePage(c, "t", rules, undefined, { fresh: true }));
      const odd = notPlain(page);
      if (odd) find(6, `a settle screen shows ${odd} (${c.attr})`);
      if (!page.includes(c.title.split(" ")[0]!)) find(6, `a settle screen does not name its page (${c.attr})`);
      for (const s of c.sides) if (!c.private && !fold(page).includes(fold(s.value))) find(3, `a settle screen does not show one of its sides (${c.attr})`);
      if (machine.some((v) => fold(page).includes(fold(v)))) find(4, "a settle screen shows a value only a machine's mail gave");
      if (codes.some((v) => squash(page).includes(squash(v)))) find(4, "a settle screen shows a voucher code");
    }
    for (const c of settle) {
      const text = `${c.what} ${c.verb} ${(c as { meta?: string }).meta ?? ""}`;
      const odd = notPlain(text);
      if (odd) find(6, `a home card shows ${odd}`);
      if (!/[.?]$/.test(c.what.trim())) find(6, "a home card's sentence has no end");
      const of = cases.find((x) => c.href === `/settle/${x.id}`);
      if (of && machineOf(keyOfCase(of)).some((v) => fold(text).includes(fold(v)))) find(4, "a home card says a value only a machine's mail gave");
    }
    // 4: the whole home, full list, right after a sign-in: no voucher code anywhere on it.
    const home = shown(homePage(homeView(root, rules, notes, later, { all: true, fresh: true }), "t"));
    for (const v of codes) if (squash(home).includes(squash(v))) find(4, "the home shows a voucher code");
    return { findings: out, asks: cases.length, answered, mails: sent.length };
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (process.env.HOME_KEEP) console.log("kept", root); else rmSync(root, { recursive: true, force: true });
  }
}
