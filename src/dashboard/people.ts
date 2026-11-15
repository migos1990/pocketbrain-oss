// SPDX-License-Identifier: AGPL-3.0-only
// The "Who matters" page: the owner's standing list (src/standing.ts, docs/standing.md) and the
// brain's suggestions from his own mail and texts. Each button is one owner commit to
// rules/standing.yaml through setStanding, the same function the CLI calls; nothing applies
// without a click, and no suggestion is ever inner circle (only the owner names family).
import { CoreError } from "../core";
import { loadBrain, type Note } from "../brain";
import type { StandingTier } from "../rules";
import { loadStanding, setStanding, suggestStanding, approveSuggestion, dismissSuggestion, dismissedSuggestions, undismissSuggestion, suggestAuthority, approveAuthority, dismissAuthority, classSets, approveStudents, bookSet, approveBook, standingProblem, unpinnedAddresses, confirmedAddresses, orphanStanding, TIERS, type Suggestion, type AuthoritySuggestion, type ClassSet } from "../standing";
import { samePersonProposals, mergeSamePerson, notSamePerson, undoPersonMerge, personMerges, type SamePerson } from "../sameperson";
import { esc, button, type Page } from "./html";
import type { State } from "./data";

const LABEL: Record<string, string> = { inner: "inner circle", close: "close", known: "known" };
const AUTH: Record<string, string> = { them: "with authority over you", owner: "under your authority" };
const HOLDS: Record<string, string> = { them: "They hold authority", owner: "You hold authority" };
const WHAT: Record<string, string> = {
  inner: "family and partner: their asks come first, the same day",
  close: "the people you rely on: soon, ahead of routine work",
  known: "people you deal with: normal priority",
};

const titleOf = (s: { notes: Note[] }, id: string) => s.notes.find((n) => n.fm.id === id)?.fm.title ?? id;
const noteLink = (s: State, id: string) => `<a href="/p/${id.split("/").map(encodeURIComponent).join("/")}"><b>${esc(titleOf(s, id))}</b></a>`;

// With no authority stored, the picker says it is not set: nothing records that the owner
// decided there is none (G865). What is stored is the same.
function levelForm(csrf: string, person: string, tier: StandingTier | undefined, authority: string | undefined, label: string) {
  const opt = (v: string, l: string, on: boolean) => `<option value="${v}"${on ? " selected" : ""}>${esc(l)}</option>`;
  return `<form class="inline lvl" method="post" action="/action/standing-set"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="person" value="${esc(person)}">`
    + `<select name="tier" aria-label="level">${TIERS.map((t) => opt(t, LABEL[t], t === tier)).join("")}</select> `
    + `<select name="authority" aria-label="authority">${opt("none", "authority not set", !authority)}${opt("owner", "you hold authority (a student, a report)", authority === "owner")}${opt("them", "they hold authority (a dean, a manager)", authority === "them")}</select> `
    + `<button>${esc(label)}</button></form>`;
}

// The addresses that produced the counts, and who vouched for each: an address only a source
// vouched for can come from a forged message, so the owner sees it before approving.
function suggestionItem(s: State, csrf: string, x: Suggestion) {
  const via = x.via.map((v) => `${esc(v.address)} <span class="sub">(${v.confirmed ? "you confirmed it" : "from a source only, not confirmed by you"})</span>`).join(", ");
  // The tap sends the level and the authority it showed; the server derives both again.
  const go = x.authority ? `Make ${LABEL[x.tier]}, ${AUTH[x.authority]}` : `Make ${LABEL[x.tier]}`;
  return `<div class="item"><div class="what"><span class="kind">suggested: ${esc(LABEL[x.tier])}</span>${noteLink(s, x.person)}<div class="sub">${esc(x.why)}</div>${via ? `<div class="sub">Counted from ${via}</div>` : ""}${x.authority ? `<div class="sub"><b>${HOLDS[x.authority]}.</b> ${esc(x.authority_why ?? "")}</div>` : ""}</div>
<div class="acts">${button(csrf, "standing-approve", { person: x.person, tier: x.tier, authority: x.authority ?? "none" }, go, "go")}${levelForm(csrf, x.person, x.tier, x.authority, "Set")}${button(csrf, "standing-dismiss", { person: x.person, tier: x.tier }, "Not now")}</div></div>`;
}

// Someone already on the list with no authority, where the owner's card or word says one.
function authorityItem(s: State, csrf: string, x: AuthoritySuggestion) {
  return `<div class="item"><div class="what"><span class="kind">suggested</span>${noteLink(s, x.person)}<div class="sub"><b>${HOLDS[x.authority]}.</b> ${esc(x.why)}</div></div>
<div class="acts">${button(csrf, "standing-authority", { person: x.person, authority: x.authority }, "Make it so", "go")}${button(csrf, "standing-authority-dismiss", { person: x.person, authority: x.authority }, "Not now")}</div></div>`;
}

// A class the owner teaches: one question for the people in its mails, each ticked, untick any.
function classItem(csrf: string, c: ClassSet) {
  const n = c.people.length;
  return `<div class="item"><div class="what"><span class="kind">your class</span>${n === 1 ? "This person is" : `These ${n} people are`} in the mails about <b>${esc(c.title)}</b>, which you teach. ${n === 1 ? "Is this your student?" : "Are they your students?"}</div>
<form class="students" method="post" action="/action/standing-students"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="course" value="${esc(c.course)}"><input type="hidden" name="shown" value="${esc(c.people.map((p) => p.id).join(","))}">
${c.people.map((p) => `<label class="tick"><input type="checkbox" name="tick:${esc(p.id)}" value="1"${p.written ? " checked" : ""}> ${esc(p.title)}${p.written ? "" : ' <span class="sub">(you have not written to them)</span>'}</label>`).join("")}
<div class="sub">The ticked ones come under your authority: their ask is a request to you. Anyone not yet on your list becomes known. Untick anyone who is not a student; anyone left unticked is not asked about again.</div>
<div class="acts"><button class="go">Yes, my students</button><button name="none" value="1">None of them</button></div></form></div>`;
}

// The rest of the address book: one question, each name ticked, untick any.
function bookItem(csrf: string, people: { id: string; title: string }[]) {
  const n = people.length;
  return `<div class="item"><div class="what"><span class="kind">your address book</span>${n === 1 ? "This person is in your address book. Make them known?" : `These ${n} people are in your address book. Make them known?`}</div>
<form class="students" method="post" action="/action/standing-book"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="shown" value="${esc(people.map((p) => p.id).join(","))}">
${people.map((p) => `<label class="tick"><input type="checkbox" name="tick:${esc(p.id)}" value="1" checked> ${esc(p.title)}</label>`).join("")}
<div class="sub">Known is normal priority: people you deal with. Untick anyone you would rather leave out; they are not asked about again.</div>
<div class="acts"><button class="go">${n === 1 ? "Make known" : "Make them known"}</button><button name="none" value="1">None of them</button></div></form></div>`;
}

// "Same person?": two person notes sharing a trusted address (src/sameperson.ts). Merge keeps the
// older note; Swap keeps the other; Not the same hides the pair until a new shared address shows.
// A pair the rules keep apart (areas, excludes by name, an open dispute) shows why, and no Merge
// or Swap that way.
function samePersonItem(s: State, csrf: string, p: SamePerson) {
  // A private pair's reason is the card's first sentence ("a private note shares a phone number"),
  // without the standing and blocked lines shown below.
  const why = p.private ? esc(p.card.slice(p.card.indexOf(": ") + 2).split(".")[0])
    : p.evidence.map((e) => `same ${esc(e.kind)} <b>${esc(e.address)}</b>: ${[p.keep, p.drop].map((id) => `${esc(titleOf(s, id))} from ${e.on[id].refs.map((r) => `<code>${esc(r)}</code>`).join(", ")}${e.on[id].added_by.length ? `, added by ${e.on[id].added_by.map(esc).join(", ")}` : ""}`).join("; ")}`).join(". ");
  return `<div class="item"><div class="what"><span class="kind">same person?</span>${noteLink(s, p.keep)} and ${noteLink(s, p.drop)}<div class="sub">${why}.${p.standing_note ? ` ${esc(p.standing_note)}` : ""} ${p.blocked ? `<b>Can't merge here: ${esc(p.blocked)}.</b>` : `Merging moves ${esc(titleOf(s, p.drop))}'s facts onto ${esc(titleOf(s, p.keep))}; differing values become questions for you, and Undo puts both back.`}</div></div>
<div class="acts">${p.blocked ? "" : button(csrf, "same-person-merge", { id: p.id }, "Merge", "go", `Merge ${titleOf(s, p.drop)} into ${titleOf(s, p.keep)}?`)}${p.swap_blocked ? "" : button(csrf, "same-person-merge", { id: p.id, swap: "1" }, `Keep ${titleOf(s, p.drop)} instead`, "", p.swap_moves_standing ? `Keep ${titleOf(s, p.drop)}? ${titleOf(s, p.keep)}'s standing moves to it.` : undefined)}${button(csrf, "same-person-not", { id: p.id }, "Not the same")}</div></div>`;
}

export function peoplePage(s: State, csrf: string): Page {
  const st = loadStanding(s.root);
  const suggestions = suggestStanding(s.root, s.notes);
  const authorities = suggestAuthority(s.root, s.notes);
  const classes = classSets(s.root, s.notes);
  const book = bookSet(s.root, s.notes);
  const asks = suggestions.length + authorities.length + classes.length + (book.length ? 1 : 0);
  const orphans = new Set(orphanStanding(s.root, s.notes));
  const placed = Object.entries(st.people).filter(([id]) => !orphans.has(id));
  const hidden = dismissedSuggestions(s.root);
  const persons = s.notes.filter((n) => n.fm.type === "person" && !st.people[n.fm.id]).sort((a, b) => a.fm.title.localeCompare(b.fm.title));
  const row = (id: string, e: (typeof st.people)[string]) => {
    const pins = e.tier === "known" ? [] : unpinnedAddresses(s.root, id, s.notes);
    const mine = new Set(confirmedAddresses(s.root, id, s.notes));
    return `<div class="item"><div class="what"><span class="kind">${esc(LABEL[e.tier])}</span>${noteLink(s, id)}${e.authority ? ` <span class="sub">${esc(AUTH[e.authority])}</span>` : ""}
<div class="sub">${e.tier === "known" ? "Matched by any confirmed address on the note." : e.addresses?.length ? `Recognised from ${e.addresses.map(esc).join(", ")}. Other addresses count as known at most.` : "No pinned address yet: they count as known at most until you confirm an address on the note and set the level again."}</div>
${pins.length ? `<div class="sub">${pins.map((a) => button(csrf, "standing-pin", { person: id, address: a }, `Pin ${a}`, "", mine.has(a) ? `Pin ${a} for ${titleOf(s, id)}? You confirmed it on the note.` : `Pin ${a} for ${titleOf(s, id)}? It came from a source, not from you; a forged message can put an address there. Pin it only if you know it is theirs.`)).join(" ")}</div>` : ""}</div>
<div class="acts">${levelForm(csrf, id, e.tier, e.authority, "Change")}${button(csrf, "standing-set", { person: id, tier: "none" }, "Remove", "danger", `Take ${titleOf(s, id)} off the list? Their asks get no special weight.`)}</div></div>`;
  };
  const broken = standingProblem(s.root);
  const same = samePersonProposals(s.root, s.notes);
  const merged = personMerges(s.root).slice(-5);
  const body = `<h1>Who matters</h1>
${broken ? `<div class="flash err">${esc(broken)}. Until you fix it by hand, every sender counts as unknown and these buttons change nothing.</div>` : ""}
<p class="sub">How much weight your assistants give someone's ask. It never changes what anyone can see, and a message counts only from an address you trust. Suggestions come from your own address book, mail and texts, each with its reason; nothing changes until you click, and only you put someone in your inner circle.</p>
${same.length || merged.length ? `<h2>Same person?${same.length ? ` (${same.length})` : ""}</h2>
<div class="card">${same.map((p) => samePersonItem(s, csrf, p)).join("")}${merged.map((m) => `<div class="item"><div class="what"><span class="kind">merged</span>${esc(m.drop)} into ${noteLink(s, m.keep)}</div><div class="acts">${button(csrf, "same-person-undo", { id: m.id }, "Undo", "", `Put ${m.drop} back as its own note?`)}</div></div>`).join("")}</div>` : ""}
<h2>Suggested${asks ? ` (${asks})` : ""}</h2>
<div class="card">${classes.map((c) => classItem(csrf, c)).join("")}${authorities.map((x) => authorityItem(s, csrf, x)).join("")}${suggestions.map((x) => suggestionItem(s, csrf, x)).join("")}${book.length ? bookItem(csrf, book) : ""}${asks ? "" : '<div class="empty">No suggestions. They come from your address book, mail and texts.</div>'}
${hidden.length ? `<div class="item"><div class="what"><span class="kind">not now</span>${hidden.map((id) => `${esc(titleOf(s, id))} ${button(csrf, "standing-undismiss", { person: id }, "Suggest again")}`).join(" ")}<div class="sub">Hidden at the level you dismissed; a higher level is still suggested.</div></div></div>` : ""}</div>
<h2>Your list</h2>
<div class="card">${TIERS.flatMap((t) => placed.filter(([, e]) => e.tier === t)).map(([id, e]) => row(id, e)).join("") || '<div class="empty">Nobody yet. Start with your inner circle below.</div>'}
${orphans.size ? `<div class="item"><div class="what"><span class="kind">no longer applies</span>${[...orphans].map(esc).join(", ")}<div class="sub">The note is gone or was replaced, so assistants don't see these. Remove them with <code>pocketbrain standing set &lt;id&gt; none</code>.</div></div></div>` : ""}</div>
<h2>Add someone</h2>
<div class="card">${persons.length ? `<form class="inline lvl" method="post" action="/action/standing-set"><input type="hidden" name="csrf" value="${esc(csrf)}"><select name="person" aria-label="person">${persons.map((n) => `<option value="${esc(n.fm.id)}">${esc(n.fm.title)}</option>`).join("")}</select> <select name="tier" aria-label="level">${TIERS.map((t) => `<option value="${t}"${t === "known" ? " selected" : ""}>${esc(LABEL[t])}</option>`).join("")}</select> <select name="authority" aria-label="authority"><option value="none">authority not set</option><option value="owner">you hold authority</option><option value="them">they hold authority</option></select> <button class="go">Add</button></form>` : '<div class="empty">Everyone with a person note is on the list.</div>'}
<div class="sub" style="margin-top:8px">${TIERS.map((t) => `<b>${esc(LABEL[t])}</b>: ${esc(WHAT[t])}`).join(" · ")}. Anyone else is unknown: assistants don't act quickly on their asks.</div></div>`;
  return { title: "Who matters", tab: "people", body };
}

// Who matters to the owner, closest first (inner, then close), by page id: for the owner's own
// page (owner-book.ts). Owner-only, like this page. A standing file that doesn't parse names nobody
// rather than take the page down (the Overview's line below says what is wrong).
export function whoMatters(root: string): string[] {
  let people: [string, { tier: string }][];
  try { people = Object.entries(loadStanding(root).people); } catch { return []; }
  return (["inner", "close"] as const).flatMap((tier) => people.filter(([, e]) => e.tier === tier).map(([id]) => id));
}

// One line in Needs you when suggestions wait.
// A broken standing or checks file must not take the Overview down with it.
export function peopleNeedsYou(root: string, notes?: Note[]): string | undefined {
  let n: number;
  const broken = standingProblem(root);
  try { if (broken) throw new Error(broken); n = suggestStanding(root, notes).length; } catch (e) {
    return `<div class="item"><div class="what"><span class="kind">who matters</span>Can't read your standing list: ${esc((e as Error).message.slice(0, 200))}. Until it is fixed, every sender counts as unknown.</div><div class="acts"><a class="btn" href="/people">Open</a></div></div>`;
  }
  let same = 0;
  try { same = samePersonProposals(root, notes).length; } catch { /* the standing line above still shows */ }
  const parts = [n ? `${n} standing suggestion${n === 1 ? "" : "s"} from your mail and texts` : "", same ? `${same} "same person?" question${same === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.length ? `<div class="item"><div class="what"><span class="kind">who matters</span>${parts.join("; ")}</div><div class="acts"><a class="btn" href="/people">Open</a></div></div>` : undefined;
}

// ---------- the buttons ----------

export function samePersonAction(root: string, action: string, f: Record<string, string>, need: (k: string) => string): string {
  const id = need("id");
  if (action === "same-person-merge") return wrap(() => mergeSamePerson(root, id, { swap: f.swap === "1" }));
  if (action === "same-person-not") return wrap(() => notSamePerson(root, id));
  if (action === "same-person-undo") return wrap(() => undoPersonMerge(root, id));
  throw new CoreError(404, `no action ${action}`);
}

function said(root: string, person: string, e: { tier: string; authority?: string } | undefined) {
  const title = titleOf({ notes: loadBrain(root) }, person);
  return e ? `${title} is now ${LABEL[e.tier]}${e.authority ? `, ${AUTH[e.authority]}` : ""}.` : `${title} has no standing now.`;
}

const wrap = <T>(f: () => T): T => { try { return f(); } catch (e) { throw e instanceof CoreError ? e : new CoreError(400, (e as Error).message); } };

export function standingAction(root: string, action: string, f: Record<string, string>, need: (k: string) => string): string {
  if (action === "standing-students") {
    const course = need("course"), shown = (f.shown ?? "").split(",").filter(Boolean);
    const ticked = f.none === "1" ? [] : Object.keys(f).filter((k) => k.startsWith("tick:") && f[k] === "1").map((k) => k.slice(5));
    const done = wrap(() => approveStudents(root, course, shown, ticked));
    return done.length ? `${done.length === 1 ? "1 person is" : `${done.length} people are`} now under your authority.` : "None of them. They won't be asked about again.";
  }
  if (action === "standing-book") {
    const shown = (f.shown ?? "").split(",").filter(Boolean);
    const ticked = f.none === "1" ? [] : Object.keys(f).filter((k) => k.startsWith("tick:") && f[k] === "1").map((k) => k.slice(5));
    const done = wrap(() => approveBook(root, shown, ticked));
    return done.length ? `${done.length === 1 ? "1 person is" : `${done.length} people are`} now known.` : "None of them. They won't be asked about again.";
  }
  const person = need("person");
  switch (action) {
    case "standing-approve": return said(root, person, wrap(() => approveSuggestion(root, person, f.tier?.trim() || undefined, f.authority?.trim() || "none")));
    case "standing-authority": return said(root, person, wrap(() => approveAuthority(root, person, need("authority"))));
    case "standing-authority-dismiss": {
      const x = wrap(() => dismissAuthority(root, person, need("authority")));
      return `${x.title} won't be suggested that way again. Suggest again brings it back.`;
    }
    case "standing-set": {
      const tier = need("tier") as StandingTier | "none";
      const authority = tier === "none" ? undefined : (f.authority?.trim() || undefined) as "owner" | "them" | "none" | undefined;
      return said(root, person, wrap(() => setStanding(root, person, tier, { authority })));
    }
    case "standing-dismiss": {
      const x = wrap(() => dismissSuggestion(root, person, f.tier?.trim() || undefined));
      return x.tier === "close" ? `${x.title} won't be suggested again. Suggest again brings them back.` : `${x.title} won't be suggested as ${LABEL[x.tier]} again.`;
    }
    case "standing-undismiss":
      wrap(() => undismissSuggestion(root, person));
      return `${titleOf({ notes: loadBrain(root) }, person)} can be suggested again.`;
    case "standing-pin": {
      const address = need("address");
      const e = loadStanding(root).people[person];
      if (!e || e.tier === "known") throw new CoreError(400, `${person} isn't inner circle or close; pins are for those`);
      wrap(() => setStanding(root, person, e.tier, { pin: [address] }));
      return `Pinned ${address} for ${titleOf({ notes: loadBrain(root) }, person)}.`;
    }
  }
  throw new CoreError(404, `no action ${action}`);
}
