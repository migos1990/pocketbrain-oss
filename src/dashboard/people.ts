// SPDX-License-Identifier: AGPL-3.0-only
// The "Who matters" page: the owner's standing list (src/standing.ts, docs/standing.md) and the
// brain's suggestions from his own mail and texts. Each button is one owner commit to
// rules/standing.yaml through setStanding, the same function the CLI calls; nothing applies
// without a click, and no suggestion is ever inner circle (only the owner names family).
import { CoreError } from "../core";
import { loadBrain, type Note } from "../brain";
import type { StandingTier } from "../rules";
import { loadStanding, setStanding, suggestStanding, approveSuggestion, dismissSuggestion, dismissedSuggestions, undismissSuggestion, standingProblem, unpinnedAddresses, confirmedAddresses, orphanStanding, TIERS, type Suggestion } from "../standing";
import { samePersonProposals, mergeSamePerson, notSamePerson, undoPersonMerge, personMerges, type SamePerson } from "../sameperson";
import { esc, button, type Page } from "./html";
import type { State } from "./data";

const LABEL: Record<string, string> = { inner: "inner circle", close: "close", known: "known" };
const AUTH: Record<string, string> = { them: "with authority over you", owner: "under your authority" };
const WHAT: Record<string, string> = {
  inner: "family and partner: their asks come first, the same day",
  close: "the people you rely on: soon, ahead of routine work",
  known: "people you deal with: normal priority",
};

const titleOf = (s: { notes: Note[] }, id: string) => s.notes.find((n) => n.fm.id === id)?.fm.title ?? id;
const noteLink = (s: State, id: string) => `<a href="/p/${id.split("/").map(encodeURIComponent).join("/")}"><b>${esc(titleOf(s, id))}</b></a>`;

function levelForm(csrf: string, person: string, tier: StandingTier | undefined, authority: string | undefined, label: string) {
  const opt = (v: string, l: string, on: boolean) => `<option value="${v}"${on ? " selected" : ""}>${esc(l)}</option>`;
  return `<form class="inline lvl" method="post" action="/action/standing-set"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="person" value="${esc(person)}">`
    + `<select name="tier" aria-label="level">${TIERS.map((t) => opt(t, LABEL[t], t === tier)).join("")}</select> `
    + `<select name="authority" aria-label="authority">${opt("none", "no authority either way", !authority)}${opt("owner", "you hold authority (a student, a report)", authority === "owner")}${opt("them", "they hold authority (a dean, a manager)", authority === "them")}</select> `
    + `<button>${esc(label)}</button></form>`;
}

// The addresses that produced the counts, and who vouched for each: an address only a source
// vouched for can come from a forged message, so the owner sees it before approving.
function suggestionItem(s: State, csrf: string, x: Suggestion) {
  const via = x.via.map((v) => `${esc(v.address)} <span class="sub">(${v.confirmed ? "you confirmed it" : "from a source only, not confirmed by you"})</span>`).join(", ");
  return `<div class="item"><div class="what"><span class="kind">suggested: ${esc(LABEL[x.tier])}</span>${noteLink(s, x.person)}<div class="sub">${esc(x.why)}</div><div class="sub">Counted from ${via}</div></div>
<div class="acts">${button(csrf, "standing-approve", { person: x.person, tier: x.tier }, `Make ${LABEL[x.tier]}`, "go")}${levelForm(csrf, x.person, x.tier, undefined, "Set")}${button(csrf, "standing-dismiss", { person: x.person, tier: x.tier }, "Not now")}</div></div>`;
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
<p class="sub">How much weight your assistants give someone's ask. It never changes what anyone can see, and a message counts only from an address you trust. Suggestions come from your own mail and texts; nothing changes until you click, and only you put someone in your inner circle.</p>
${same.length || merged.length ? `<h2>Same person?${same.length ? ` (${same.length})` : ""}</h2>
<div class="card">${same.map((p) => samePersonItem(s, csrf, p)).join("")}${merged.map((m) => `<div class="item"><div class="what"><span class="kind">merged</span>${esc(m.drop)} into ${noteLink(s, m.keep)}</div><div class="acts">${button(csrf, "same-person-undo", { id: m.id }, "Undo", "", `Put ${m.drop} back as its own note?`)}</div></div>`).join("")}</div>` : ""}
<h2>Suggested${suggestions.length ? ` (${suggestions.length})` : ""}</h2>
<div class="card">${suggestions.map((x) => suggestionItem(s, csrf, x)).join("") || '<div class="empty">No suggestions. They come from mail and texts the brain reads.</div>'}
${hidden.length ? `<div class="item"><div class="what"><span class="kind">not now</span>${hidden.map((id) => `${esc(titleOf(s, id))} ${button(csrf, "standing-undismiss", { person: id }, "Suggest again")}`).join(" ")}<div class="sub">Hidden at the level you dismissed; a higher level is still suggested.</div></div></div>` : ""}</div>
<h2>Your list</h2>
<div class="card">${TIERS.flatMap((t) => placed.filter(([, e]) => e.tier === t)).map(([id, e]) => row(id, e)).join("") || '<div class="empty">Nobody yet. Start with your inner circle below.</div>'}
${orphans.size ? `<div class="item"><div class="what"><span class="kind">no longer applies</span>${[...orphans].map(esc).join(", ")}<div class="sub">The note is gone or was replaced, so assistants don't see these. Remove them with <code>pocketbrain standing set &lt;id&gt; none</code>.</div></div></div>` : ""}</div>
<h2>Add someone</h2>
<div class="card">${persons.length ? `<form class="inline lvl" method="post" action="/action/standing-set"><input type="hidden" name="csrf" value="${esc(csrf)}"><select name="person" aria-label="person">${persons.map((n) => `<option value="${esc(n.fm.id)}">${esc(n.fm.title)}</option>`).join("")}</select> <select name="tier" aria-label="level">${TIERS.map((t) => `<option value="${t}"${t === "known" ? " selected" : ""}>${esc(LABEL[t])}</option>`).join("")}</select> <select name="authority" aria-label="authority"><option value="none">no authority either way</option><option value="owner">you hold authority</option><option value="them">they hold authority</option></select> <button class="go">Add</button></form>` : '<div class="empty">Everyone with a person note is on the list.</div>'}
<div class="sub" style="margin-top:8px">${TIERS.map((t) => `<b>${esc(LABEL[t])}</b>: ${esc(WHAT[t])}`).join(" · ")}. Anyone else is unknown: assistants don't act quickly on their asks.</div></div>`;
  return { title: "Who matters", tab: "people", body };
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
  const person = need("person");
  switch (action) {
    case "standing-approve": return said(root, person, wrap(() => approveSuggestion(root, person, f.tier?.trim() || undefined)));
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
