// SPDX-License-Identifier: AGPL-3.0-only
// Made-up weeks for the Home property (test/home-property.test.ts, G987): a seed gives a week of
// mail to an invented owner from people they know, built from cases whose right answer the
// generator knows before any hub code runs. A case owns one fact (a page and an attribute) and is
// one of:
//   clash     two people, the same day, two values that cannot both hold      -> one question
//   three     three people, the same day, three values                        -> one question, three sides
//   split     three people, the same day, two of them with one value          -> one question, two sides
//   agree     two people, the same day, the same value                        -> none
//   forward   one person, then another on a later day with a newer value      -> none
//   reworded  two people, the same day, one value in two spellings            -> none
//   machine   a person, and the same day a no-reply sender with another value -> none, and the
//             machine's value on no screen
//   code      a person's mail whose next step carries a voucher code, read by a careless
//             extractor that hands the code back                              -> none, and the
//             code on no screen
//   steps     two people, the same day, two different next steps for one project (G965: a page
//             holds several things to do)                                     -> none, and both
//             steps on the project's page
//   answered  a clash the owner then answers (a side, the other side, keep both, or their own
//             words); some are said again by the same sender the day after    -> gone, and it stays gone
// Every name, role and sentence here is invented for this file.
import { prng } from "./carve-gen";

export type Kind = "clash" | "three" | "split" | "agree" | "forward" | "reworded" | "machine" | "code" | "steps" | "answered";
export type Answer = "first" | "second" | "both" | "typed";
export interface Mail { day: number; minute: number; from: number | "machine"; entity: string; type: "person" | "project"; attribute: string; value: string; sentence: string; stem?: string }
export interface Case { kind: Kind; key: string; entity: string; attribute: string; mails: Mail[]; sides?: number; answer?: Answer; typed?: string; again?: Mail; never?: string[]; both?: string[] }
export interface Week { seed: number; owner: { name: string; address: string }; people: string[]; cases: Case[] }

export const OWNER = { name: "Mara Quill", address: "mara@example.org" };
export const PEOPLE = ["Ivo Brandt", "Lena Marsh", "Tariq Sole", "Nell Aubrey", "Odin Vance", "Pia Lund", "Rafe Castor", "Suki Thorne"];
export const PROJECTS = ["Orchard Survey", "Winter Fair", "Ferry Timetable", "Archive Scan"];
// No role or place holds a word a privacy rule reads as health, school, legal or money (the north
// star's lesson: such a word makes a page private by accident, which is another test's subject).
const ROLES = ["field lead", "volunteer host", "route planner", "scan operator", "press contact", "stage manager", "site steward", "data keeper", "tour guide", "print buyer", "floor captain", "map editor"];
const ORGS = ["Tide Works", "Alder Hall", "Quay Trust", "Fern Guild", "Mill Row Studio", "Lantern House", "Cedar Wharf", "Moss Lane Press"];
const STEPS = ["count the east rows", "order the stall tents", "post the spring sailings", "box the old ledgers"];
// Projects for the two-steps case: titles the hub starts a page for (an errand's or a trip's title starts
// none), with no word a privacy rule reads as money (a step about money is asked, by design).
const BUSY = ["Harbour Map", "Seed Library", "Bell Tower Repair", "Reed Marsh Census"];
// Things to do that are not each other in other words: two of them on one project are two steps.
const MORE_STEPS = ["hire the tally clerks", "paint the gate signs", "weigh the spare crates", "mend the reading lamps", "chart the tide tables", "label the seed trays"];
const TYPED = ["harbour liaison", "Birch Yard"];

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const keyOf = (type: Mail["type"], entity: string, attribute: string) => `${type === "person" ? "people" : "projects"}/${slug(entity)}#${attribute}`;
export const senderOf = (k: number | "machine") => k === "machine" ? "no-reply@example.net" : `friend${k}@example.org`;

// A voucher code in the shape shops mail: built here from the seed, never written whole in a file.
const voucher = (r: () => number) => { const g = () => Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(r() * 32)]).join(""); return `${g()}-${g()}-${g().slice(0, 3)}7`; };

const say = (entity: string, attribute: string, value: string, other: string) =>
  attribute === "role" ? `${entity} is now the ${value} for the ${other} team this season`
  : attribute === "org" ? `${entity} works at ${value} and helps with the ${other} there`
  : `For the ${entity} the next step is to ${value} with ${other}`;

export function week(seed: number): Week {
  const r = prng(seed ^ 0x40e5);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r.next() * xs.length)]!;
  const two = <T,>(xs: T[]): [T, T] => { const a = Math.floor(r.next() * xs.length); let b = Math.floor(r.next() * (xs.length - 1)); if (b >= a) b++; return [xs[a]!, xs[b]!]; };
  // One fact per case: each person's role and org, in an order the seed shuffles.
  // (A shuffle by swaps: a sort with a random comparator is not the same order on every run.)
  const slots = PEOPLE.flatMap((p) => (["role", "org"] as const).map((a) => ({ entity: p, attribute: a })));
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); [slots[i], slots[j]] = [slots[j]!, slots[i]!]; }
  // Every week has a clash and an answered one, so no run is empty; the rest are drawn.
  const kinds: Kind[] = ["clash", "answered", ...Array.from({ length: 4 + Math.floor(r.next() * 4) }, () => pick<Kind>(["clash", "three", "split", "agree", "forward", "reworded", "machine", "answered", "answered"]))];
  let minute = 0;
  const cases: Case[] = kinds.map((kind, i) => {
    const { entity, attribute } = slots[i]!;
    const me = PEOPLE.indexOf(entity);
    // Two senders who are not the person the fact is about.
    const [a, b] = two(PEOPLE.map((_, k) => k).filter((k) => k !== me));
    const [v1, v2] = two(attribute === "role" ? ROLES : ORGS);
    // A third sender and a third value, for the cases with three mails.
    const c = pick(PEOPLE.map((_, k) => k).filter((k) => k !== me && k !== a && k !== b));
    const v3 = pick((attribute === "role" ? ROLES : ORGS).filter((v) => v !== v1 && v !== v2));
    const other = pick(PROJECTS);
    const mail = (day: number, from: Mail["from"], value: string): Mail => ({ day, minute: minute++, from, entity, type: "person", attribute, value, sentence: say(entity, attribute, value, other) });
    const day = 1 + Math.floor(r.next() * 4);
    const key = keyOf("person", entity, attribute);
    if (kind === "three") return { kind, key, entity, attribute, sides: 3, mails: [mail(day, a, v1), mail(day, b, v2), mail(day, c, v3)] };
    if (kind === "split") return { kind, key, entity, attribute, sides: 2, mails: [mail(day, a, v1), mail(day, b, v2), mail(day, c, v1)] };
    if (kind === "agree") return { kind, key, entity, attribute, mails: [mail(day, a, v1), mail(day, b, v1)] };
    if (kind === "forward") return { kind, key, entity, attribute, mails: [mail(1, a, v1), mail(3 + Math.floor(r.next() * 2), b, v2)] };
    if (kind === "reworded") return { kind, key, entity, attribute, mails: [mail(day, a, v1), mail(day, b, v1.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/ /g, "  "))] };
    if (kind === "machine") return { kind, key, entity, attribute, mails: [mail(day, a, v1), mail(day, "machine", v2)], never: [v2] };
    if (kind === "answered") {
      const answer = pick<Answer>(["first", "second", "both", "typed"]);
      const typed = attribute === "role" ? TYPED[0]! : TYPED[1]!;
      // Said again the day after the answer, by the sender whose value did not stand (either, for both).
      const again = r.next() < 0.5 ? { ...mail(7, answer === "second" ? a : b, answer === "second" ? v1 : v2) } : undefined;
      return { kind, key, entity, attribute, mails: [mail(day, a, v1), mail(day, b, v2)], answer, ...(answer === "typed" ? { typed } : {}), ...(again ? { again } : {}) };
    }
    return { kind, key, entity, attribute, mails: [mail(day, a, v1), mail(day, b, v2)] };
  });
  // One project in every week gets a next step, then a later one that carries a voucher code.
  const project = pick(PROJECTS), code = voucher(r.next), [a, b] = two(PEOPLE.map((_, k) => k));
  const stem = `For the ${project} the next step is to redeem the print voucher`;
  cases.push({ kind: "code", key: keyOf("project", project, "next_step"), entity: project, attribute: "next_step", never: [code], mails: [
    { day: 1, minute: minute++, from: a, entity: project, type: "project", attribute: "next_step", value: STEPS[PROJECTS.indexOf(project)]!, sentence: say(project, "next_step", STEPS[PROJECTS.indexOf(project)]!, PEOPLE[a]!) },
    { day: 4, minute: minute++, from: b, entity: project, type: "project", attribute: "next_step", value: `redeem the print voucher ${code}`, sentence: `${stem} ${code} before Friday`, stem },
  ] });
  // Another project gets two next steps the same day, from two people. (Drawn after everything
  // above, so the weeks of the seeds kept in test/fixtures/home-seeds.json are the weeks they were.)
  const busy = pick(BUSY), [s1, s2] = two(MORE_STEPS), [c, d] = two(PEOPLE.map((_, k) => k)), when = 2 + Math.floor(r.next() * 3);
  const step = (from: number, value: string): Mail => ({ day: when, minute: minute++, from, entity: busy, type: "project", attribute: "next_step", value, sentence: say(busy, "next_step", value, PEOPLE[from]!) });
  cases.push({ kind: "steps", key: keyOf("project", busy, "next_step"), entity: busy, attribute: "next_step", both: [s1, s2], mails: [step(c, s1), step(d, s2)] });
  return { seed, owner: OWNER, people: PEOPLE, cases };
}

// The facts the generator says ask the owner, at the end of the week: the clashes nobody answered.
// `sides` on a case is how many values its question shows (two when not said).
export const asked = (w: Week) => w.cases.filter((c) => c.kind === "clash" || c.kind === "three" || c.kind === "split").map((c) => c.key);
// Strings no screen may show: a machine's value, a voucher code.
export const never = (w: Week) => w.cases.flatMap((c) => c.never ?? []);

// A careless extractor: every sentence it is shown comes back as a fact, the voucher's code too
// (it matches that mail by the words before the code, since the hub takes the code out first).
export const careless = (w: Week, upTo: Mail[]) => (prompt: string) => JSON.stringify({ facts: upTo.filter((m) => prompt.includes(m.stem ?? m.sentence)).map((m) => ({ entity: m.entity, type: m.type, attribute: m.attribute, value: m.value, quote: m.sentence })) });
