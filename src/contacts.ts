// SPDX-License-Identifier: AGPL-3.0-only
// The owner's contacts as a source (docs/sources-pull.md#contacts): Google Contacts (src/google.ts
// fetchContacts, read only) or a vCard file exported from a phone. A card is structured, so it is
// read by code, never sent to a model: each line becomes a candidate fact on the person it names,
// checked and filed through the same path as a pulled mail's facts (capture.ts fileCard), citing
// the card as contacts:<card id>@<version>.
//
// What a card may say, and what it may not:
//   - a person page that exists gets the card's job title (role) and company (org) when it has
//     none, its nicknames (aliases), and its emails and phones, those two private, so they sit
//     behind Show like any private value;
//   - a job title or company that differs from the page's is dropped: cards go stale for years;
//   - the owner's own card names family ("father", "spouse"): that is the relationship on the
//     related person's page, and the only way a card starts a new page;
//   - a relationship that differs from the page's is filed like any other contradiction: a
//     conflict the owner settles;
//   - nicknames are kept as a fact and never used to match a name to a page (a card proves an
//     address, not who someone is; the wiki thread, 2026-10-31). Same-person merges come from a
//     shared email or phone (src/sameperson.ts).
// Addresses, birthdays, notes and groups are not read.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Note } from "./brain";
import type { Rules } from "./rules";
import type { Candidate, CaptureItem } from "./capture";
import { ownerOf, ownerTitle } from "./capture";
import { personKey } from "./write";
import { compareKey } from "./normalize";
import { hasWord } from "./util";
import type { SourceConfig, SourceItem } from "./pull";
import { cardVersion } from "./google";

type Raw = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// ---------- a card, as Google's People API gives it (a vCard is parsed into the same shape) ----------

// A relation's kind in plain words: Google's types (domesticPartner), Apple's labels
// (_$!<Father>!$_) or a custom one. Anything but a short run of words is dropped.
const KIND: Record<string, string> = { domesticpartner: "partner", referredby: "", spouse: "spouse", child: "child", mother: "mother", father: "father", parent: "parent", brother: "brother", sister: "sister", friend: "friend", relative: "relative", manager: "manager", assistant: "assistant", partner: "partner" };
export function relationKind(t: unknown): string | undefined {
  const s = str(t).replace(/^_\$!<(.*)>!\$_$/, "$1");
  if (!s) return undefined;
  const k = KIND[s.toLowerCase().replace(/[^a-z]/g, "")];
  if (k !== undefined) return k || undefined;
  const w = s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return /^[\p{L}][\p{L} '-]{0,29}$/u.test(w) ? w : undefined;
}

export interface Card { name: string; nicknames: string[]; title?: string; company?: string; emails: string[]; phones: string[]; relations: { kind: string; name: string }[]; updated?: string }
export function readCard(r: Raw): Card | undefined {
  const name = str(r.names?.[0]?.displayName) || [str(r.names?.[0]?.givenName), str(r.names?.[0]?.familyName)].filter(Boolean).join(" ");
  if (!name) return undefined; // a company card or an address alone names no one
  const each = (xs: unknown, f: (x: Raw) => unknown) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => str(f(x))).filter(Boolean))];
  const org = Array.isArray(r.organizations) ? r.organizations[0] ?? {} : {};
  const updated = (Array.isArray(r.metadata?.sources) ? r.metadata.sources : []).map((s: Raw) => str(s.updateTime)).filter(Boolean).sort().at(-1) || str(r.updated) || undefined;
  return {
    name, nicknames: each(r.nicknames, (x) => x.value), title: str(org.title) || undefined, company: str(org.name) || undefined,
    emails: each(r.emailAddresses, (x) => x.value), phones: each(r.phoneNumbers, (x) => x.canonicalForm ?? x.value),
    relations: (Array.isArray(r.relations) ? r.relations : []).flatMap((x: Raw) => { const kind = relationKind(x.type ?? x.formattedType), n = str(x.person); return kind && n ? [{ kind, name: n }] : []; }),
    ...(updated ? { updated } : {}),
  };
}

// The card as text, one line per thing it says: what the checks ground each candidate in. Held in
// memory only (pull.ts distil), never stored. Each line names the card's person, so a recheck reads
// it as said about them (pull.ts recheckFacts, namedSentence).
const LINE = {
  name: (n: string) => `Name: ${n}`, nickname: (n: string, v: string) => `${n}, nickname: ${v}`, title: (n: string, v: string) => `${n}, job title: ${v}`, company: (n: string, v: string) => `${n}, company: ${v}`,
  email: (n: string, v: string) => `${n}, email: ${v}`, phone: (n: string, v: string) => `${n}, phone: ${v}`, related: (n: string, k: string, v: string) => `${n}, related (${k}): ${v}`,
};
export function cardText(c: Card): string {
  const n = c.name;
  return [LINE.name(n), ...c.nicknames.map((v) => LINE.nickname(n, v)), ...(c.title ? [LINE.title(n, c.title)] : []), ...(c.company ? [LINE.company(n, c.company)] : []),
    ...c.emails.map((v) => LINE.email(n, v)), ...c.phones.map((v) => LINE.phone(n, v)), ...c.relations.map((r) => LINE.related(n, r.kind, r.name))].join("\n");
}
// A card as verify_source may check a claim against it: without its email and phone lines, which
// are filed private and held until Show, so no quote or match can give them away (builder's slice
// audit, 2026-10-31). Upkeep's recheck still reads the whole card, and returns fact keys only.
export const withoutDetails = (text: string) => text.split("\n").filter((l) => !/^[^\n]*, (email|phone): /.test(l)).join("\n");

// pull.ts toItem: id = the card's resource name, version = its etag (an edited card is a new version,
// and the facts citing the old one turn due).
export function cardItem(r: Raw): SourceItem | undefined {
  const id = str(r.resourceName);
  if (!id) return undefined;
  const version = cardVersion(r.etag);
  if (r.metadata?.deleted || r.deleted) return { id, version, text: "", gone: true, where: "contacts" };
  const c = readCard(r);
  if (!c) return undefined;
  return { id, version, text: cardText(c), ...(c.updated ? { at: c.updated } : {}), where: "contacts" };
}

// ---------- what a card says, as candidate facts ----------

const isOwnerCard = (c: Card, rules: Rules, notes: Note[]) => !!ownerOf(rules, notes, c.name);
const firstName = (rules: Rules) => ownerTitle(rules)?.split(/\s+/)[0];

export function cardCandidates(c: Card, rules: Rules, notes: Note[]): Candidate[] {
  const day = c.updated && /^\d{4}-\d{2}-\d{2}/.test(c.updated) ? { as_of: c.updated.slice(0, 10) } : {};
  const fact = (attribute: string, value: string, quote: string, entity = c.name): Candidate => ({ entity, type: "person", attribute, value, quote, ...day });
  const out: Candidate[] = [
    ...c.nicknames.map((v) => fact("aliases", v, LINE.nickname(c.name, v))),
    ...(c.title ? [fact("role", c.title, LINE.title(c.name, c.title))] : []),
    ...(c.company ? [fact("org", c.company, LINE.company(c.name, c.company))] : []),
    ...c.emails.map((v) => fact("emails", v, LINE.email(c.name, v))),
    ...c.phones.map((v) => fact("phones", v, LINE.phone(c.name, v))),
  ];
  // The owner's own card: who is family, said in the brain's own words ("Robin's mother").
  if (isOwnerCard(c, rules, notes)) {
    const me = firstName(rules);
    for (const r of c.relations) out.push(fact("relationship", me ? `${me}'s ${r.kind}` : r.kind, LINE.related(c.name, r.kind, r.name), r.name));
  }
  return out;
}

// The people the owner's own card names, among the cards of one pass: the only new pages a card starts.
export function ownerRelations(raws: Raw[], rules: Rules, notes: Note[]): Set<string> {
  const out = new Set<string>();
  for (const r of raws) {
    const c = readCard(r);
    if (c && isOwnerCard(c, rules, notes)) for (const x of c.relations) out.add(personKey(x.name));
  }
  return out;
}

// Each checked candidate, kept, changed or dropped with why (capture.ts fileCard).
export const CARD_WHY = {
  noPage: "a contact card starts no page; only a person your own card names as family does",
  stale: "a contact card's job title and company are often years old: they fill an empty one, never replace one",
  noOrg: "no page for that company yet; a contact card starts none",
  said: "the page already says so",
  otherName: "that nickname is another person's name",
};
export function cardAdjust(it: CaptureItem, notes: Note[], family: Set<string>): CaptureItem | string {
  if (!["known", "changes", "new-fact", "new-note"].includes(it.status)) return it;
  const c = it.candidate;
  if (it.status === "new-note" && !family.has(personKey(c.entity))) return CARD_WHY.noPage;
  if ((c.attribute === "role" || c.attribute === "org") && it.status === "changes") return CARD_WHY.stale;
  if (c.attribute === "org" && it.status !== "known") {
    const org = notes.find((n) => n.fm.type === "org" && [n.fm.title, ...(n.fm.aliases ?? [])].some((t) => compareKey(t) === compareKey(c.value)));
    if (!org) return CARD_WHY.noOrg;
    return { ...it, candidate: { ...c, value: `[[${org.fm.id}]]` } };
  }
  // "Robin's daughter, 9" already says what "Robin's daughter" does.
  if (c.attribute === "relationship" && it.status === "changes") {
    const kind = c.value.replace(/^.*'s /, "");
    if ((it.current ?? "").split("; ").some((v) => hasWord(v, kind))) return CARD_WHY.said;
  }
  if (c.attribute === "emails" || c.attribute === "phones") return { ...it, floor: "private" };
  // A nickname that is another person's name ("Hélène Lefebvre" on Priya's card) would mix the two
  // in search: never filed.
  if (c.attribute === "aliases" && notes.some((n) => n.fm.type === "person" && n.fm.id !== it.target && [n.fm.title, ...(n.fm.aliases ?? [])].some((t) => personKey(t) === personKey(c.value)))) return CARD_WHY.otherName;
  return it;
}

// ---------- a vCard file (an iPhone or Google export) ----------

// The cards of a .vcf file, in the People API's shape. A card's id is its UID, else a hash of its
// name and first email or phone; its version a hash of what it says, so an edited card is new.
export function parseVcards(text: string): Raw[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: Raw[] = [];
  let cur: { key: string; params: string; group: string; value: string }[] | undefined;
  for (const line of lines) {
    if (/^BEGIN:VCARD$/i.test(line.trim())) { cur = []; continue; }
    if (/^END:VCARD$/i.test(line.trim())) { if (cur) { const r = vcardPerson(cur); if (r) out.push(r); } cur = undefined; continue; }
    if (!cur) continue;
    const m = line.match(/^(?:([^.:;]+)\.)?([^:;]+)((?:;[^:]*)?):(.*)$/);
    if (m) cur.push({ group: (m[1] ?? "").toLowerCase(), key: m[2].toUpperCase(), params: m[3], value: m[4] });
  }
  return out;
}
const unesc = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
function vcardPerson(props: { key: string; params: string; group: string; value: string }[]): Raw | undefined {
  const one = (k: string) => props.find((p) => p.key === k)?.value;
  const all = (k: string) => props.filter((p) => p.key === k);
  const n = (one("N") ?? "").split(";").map(unesc);
  const name = unesc(one("FN") ?? "") || [n[1], n[0]].filter(Boolean).join(" ");
  // Apple marks a company's card X-ABShowAs: COMPANY; its FN is the company, not a person.
  if (!name || /^company$/i.test((one("X-ABSHOWAS") ?? "").trim())) return undefined;
  const label = (group: string) => props.find((p) => p.group && p.group === group && p.key === "X-ABLABEL")?.value;
  const relations = [
    ...all("X-ABRELATEDNAMES").map((p) => ({ person: unesc(p.value), type: label(p.group) ?? "relative" })),
    ...all("RELATED").filter((p) => !/VALUE=uri/i.test(p.params) && !/^(urn|https?|mailto):/i.test(p.value)).map((p) => ({ person: unesc(p.value), type: p.params.match(/TYPE=([^;:]+)/i)?.[1]?.split(",")[0] ?? "relative" })),
  ];
  const org = one("ORG") ? unesc(one("ORG")!.split(/(?<!\\);/)[0]) : undefined;
  const title = one("TITLE") ? unesc(one("TITLE")!) : undefined;
  const emails = all("EMAIL").map((p) => unesc(p.value)).filter(Boolean);
  const phones = all("TEL").map((p) => unesc(p.value).replace(/^tel:/i, "")).filter(Boolean);
  const body = JSON.stringify({ name, nick: all("NICKNAME").map((p) => p.value), org, title, emails, phones, relations });
  const rev = one("REV");
  const updated = rev && /^\d{4}-?\d{2}-?\d{2}/.test(rev) ? rev.replace(/^(\d{4})-?(\d{2})-?(\d{2}).*$/, "$1-$2-$3") : undefined;
  return {
    resourceName: `vcard/${unesc(one("UID") ?? "") || sha(`${name}|${emails[0] ?? phones[0] ?? ""}`)}`, etag: sha(body),
    names: [{ displayName: name }],
    nicknames: all("NICKNAME").flatMap((p) => unesc(p.value).split(",")).map((v) => ({ value: v.trim() })).filter((x) => x.value),
    ...(org || title ? { organizations: [{ ...(org ? { name: org } : {}), ...(title ? { title } : {}) }] } : {}),
    emailAddresses: emails.map((value) => ({ value })), phoneNumbers: phones.map((value) => ({ value })), relations,
    ...(updated ? { metadata: { sources: [{ updateTime: updated }] } } : {}),
  };
}

// A live vCard source: `path:` is a .vcf file or a folder of them, read whole each pass. A card no
// longer in the export comes back as gone (its facts turn due); the cursor is the ids last seen.
export function fetchVcards(cfg: SourceConfig, cursor?: string): { items: Raw[]; cursor: string } {
  const p = cfg.path;
  if (!p) throw new Error("a vCard contacts source needs path: (a .vcf file or a folder of them)");
  if (!existsSync(p)) throw new Error(`no vCard file at ${p}`);
  const files = statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.vcf$/i.test(f)).sort().map((f) => join(p, f)) : [p];
  const items = files.flatMap((f) => parseVcards(readFileSync(f, "utf8")));
  const now = new Set(items.map((r) => String(r.resourceName)));
  let before: string[] = [];
  try { before = cursor ? JSON.parse(cursor) : []; } catch { before = []; }
  const gone = before.filter((id) => !now.has(id)).map((id) => ({ resourceName: id, metadata: { deleted: true } }));
  return { items: [...items, ...gone], cursor: JSON.stringify([...now]) };
}
