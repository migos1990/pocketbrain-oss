// SPDX-License-Identifier: AGPL-3.0-only
// Everything on the hub that needs Louis, as one list of items with stable keys. Read-only.
// Each item carries a title that is safe to put in a text: no value of a private or money
// fact, no held-mail body, no relay reason (those quote the very value that was held).
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { sha256 } from "../util";
import { loadBrain, sensitivityRank, type Note, type FactRecord } from "../brain";
import { loadRules, isOwnerWord } from "../rules";
import { pendingGardener, gardenerSeen, type GardenerReads } from "../gardener-hold";
import { git, porcelainPath } from "../git";
import { findInjection, findSecret, thirdPartySensitive, categoryWords } from "../checks";
import { hasWord } from "../util";
import { proposals, comms, disputes, upkeepRuns, jsonl, type DisputeRow } from "../dashboard/data";
import type { Kind, EscalationPolicy } from "./policy";
import { usageItem } from "../usage";
import { heldCaptures, captureAgent } from "../capture";
import { getQuote } from "../quotes";
import { waitingActions } from "../act";
import { sensitiveShape, reasonText } from "../shape";

export type Verb = "approve" | "reject" | "later" | "ok" | "pick";

export interface Item {
  key: string;
  kind: Kind;
  title: string; // safe for a text
  private: boolean; // private or above: values never in a text
  money: boolean;
  verbs: Verb[]; // what a reply can do with it: never decide a fact or a conflict (outside review v5)
  options?: string[]; // dispute candidates, only when not private
  suggested?: number; // 1-based, a dispute's suggested answer
  suggested_by?: string; // set when the gardener suggested it, not the resolver
  waiting_on_resolver?: boolean; // an open dispute the resolver may still settle
  at?: string; // when it appeared, if the item knows
  ref: string; // what the dashboard or CLI calls it (proposal file, mail id, dispute id)
  code?: string; // an agent's mail (kind action): the 6-digit code a reply must quote (G146)
  check?: string; // an alert's check name, as the alert log records it
}

const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// Agent-written text (proposal values, titles) goes to Louis through Instinct, an LLM. Text
// that reads as instructions or carries a secret never goes; one line, never markup.
const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/[<>`]/g, "");
const unsafe = (s: string) => !!(findInjection(s) || findSecret(s));
// Money words in a proposal's reason or source quote (G67, G93), on top of the owner's money category words.
const MONEY_WORDS = /withheld_category|money|bank|card|salar(y|ies)|salaire|wage|loan|mortgage|hypoth\p{L}*|\$\s?\d|\d\s?(\$|€|dollars?\b)/iu;
const show = (v: unknown) => {
  const s = clean(typeof v === "object" ? JSON.stringify(v) : String(v));
  return unsafe(s) ? "[withheld: looks like instructions or a secret]" : short(s, 40);
};
const hash = (s: string) => sha256(s).slice(0, 10);
const INSTEAD = "Read it in the dashboard";

function noteFor(notes: Note[], idOrKey: string | undefined): Note | undefined {
  if (!idOrKey) return undefined;
  const id = idOrKey.split("#")[0];
  return notes.find((n) => n.fm.id === id);
}
const isMoney = (n: Note | undefined, key = "") => n?.fm.type === "money" || /^money\//.test(key) || (n?.fm.tags ?? []).includes("finance");
const isPrivate = (levels: (string | undefined)[]) => levels.some((s) => s && sensitivityRank(s as never) >= sensitivityRank("private"));

// Only proposeItem (src/capture.ts) writes a top-level `capture:` field; an agent's proposal can't.
function isCaptureProposal(root: string, file: string): boolean {
  try { return typeof (YAML.parse(readFileSync(join(root, "inbox", file), "utf8")) as { capture?: unknown } | null)?.capture === "string"; } catch { return false; }
}

// Alerts and agent commits to rules/ older than this are history, not news.
const RECENT_DAYS = 7;

// Refusals the hub makes on purpose, and notices, are the record of it working, not owner work
// (owner, 2026-10-24: "73 need you", nearly all alerts): a runaway agent turned away by its
// budget, a source item held or not matching its claim (both on the source doctor and Activity).
// carve_widened stays: it is the weekly carve audit's only output (safety review, 2026-10-24).
const BY_DESIGN = new Set(["request_budget", "source_held", "source_mismatch"]);
// Records the hub keeps, never a problem (the gardener's first pinned ant).
const INFO = new Set(["gardener_ant_pinned"]);

// A failure alert closes by itself once its check passes again: the source read since, the probe
// ok now, the hub ticking since it hung. Without a pass on record it stays open.
// Whether an alert is still owner-facing: not a by-design refusal, and its check hasn't passed
// since. One rule for the owner queue, the text and doctor's ops line.
export function alertOpen(root: string): (a: Record<string, unknown>) => boolean {
  const passed = passedSince(root);
  return (a) => !BY_DESIGN.has(String(a.check)) && !INFO.has(String(a.check)) && !passed(a);
}

function passedSince(root: string): (a: Record<string, unknown>) => boolean {
  let probe: Record<string, { ok?: boolean }> = {};
  try { probe = JSON.parse(readFileSync(join(root, "log", "probe.json"), "utf8")); } catch { /* none yet */ }
  const runs = jsonl(join(root, "log", "sources", "runs.jsonl"));
  const beat = lastHeartbeat(root) ?? "";
  return (a) => {
    const check = String(a.check ?? ""), at = String(a.at ?? "");
    if (check === "probe_hub_hung") return beat > at;
    if (check.startsWith("probe_")) return probe[check.replace(/^probe_(warn_)?/, "")]?.ok === true;
    // A failed rotation's own alert closes with its job check (src/probe.ts gardener_rotate).
    if (check === "gardener_ant" && a.from === "rotate") return probe.gardener_rotate?.ok === true;
    // A lost ant login's one alert closes once no gardener job fails on it (G745).
    if (check === "gardener_ant" && a.from === "signin") return probe.gardener_signin?.ok === true;
    if (check === "source_failed") return runs.some((r) => `source:${r.source}` === a.agent && !r.refused && String(r.at) > at);
    return false;
  };
}

// A conflict waiting for the Gardener (src/gardener-hold.ts) isn't asked yet, unless it is on a
// private note or reads like money, health or legal: that one asks the same day behind Show it.
export { GARDENER_WAIT_H, gardenerSeen } from "../gardener-hold";
export function heldForGardener(rules: ReturnType<typeof loadRules>, d: Pick<DisputeRow, "fact_key" | "status" | "suggestion" | "candidates" | "sensitivity" | "gardener_first" | "gardener_seen">, target: Note | undefined, seen: GardenerReads, now: Date): boolean {
  return pendingGardener(d, seen, now) && !gardenerUrgent(rules, d, target);
}
// A conflict whose values never show without a tap: a private note, side or packet, money, or a
// value that reads like money, health or legal.
export const disputeSensitive = (rules: ReturnType<typeof loadRules>, d: Pick<DisputeRow, "fact_key" | "candidates" | "sensitivity">, target: Note | undefined) =>
  isPrivate([d.sensitivity, target?.fm.sensitivity, ...d.candidates.map((c: FactRecord) => c.sensitivity)]) || isMoney(target, d.fact_key) || !!sensitiveShape(rules, d.fact_key, ...d.candidates.map((c: FactRecord) => c.value));
const gardenerUrgent = (rules: ReturnType<typeof loadRules>, d: Pick<DisputeRow, "fact_key" | "candidates" | "sensitivity" | "gardener_first">, target: Note | undefined) =>
  typeof d.gardener_first === "string" && disputeSensitive(rules, d, target);

export function openItems(root: string, now = new Date()): Item[] {
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const notes = loadBrain(root);
  const rules = loadRules(root);
  const out: Item[] = [];

  // Disputes: open (the resolver may still settle), escalated (it gave up), answer-held.
  const seen = gardenerSeen(root, rules);
  for (const d of disputes(notes)) {
    if (!["open", "escalated", "answer-held"].includes(d.status)) continue;
    const target = noteFor(notes, d.fact_key);
    if (heldForGardener(rules, d, target, seen, now)) continue;
    // One that asks at once for its shape keeps its values behind Show it (G416).
    const priv = isPrivate([d.sensitivity, target?.fm.sensitivity, ...d.candidates.map((c: FactRecord) => c.sensitivity)]) || gardenerUrgent(rules, d, target);
    const money = isMoney(target, d.fact_key);
    const louisOnly = priv || d.candidates.some((c) => isOwnerWord(rules, target?.fm.area, c));
    const where = priv ? `a ${money ? "money" : "private"} fact` : d.fact_key;
    if (d.status === "answer-held") {
      const a = d.answer as { relayed_by?: string; value?: unknown } | undefined;
      out.push({ key: `held-answer:${d.id}`, kind: "held-answer", ref: d.id, private: priv, money, verbs: ["later"],
        title: `${a?.relayed_by ?? "the resolver"} says you answered ${d.id} on ${where}${priv ? "" : ` with ${show(a?.value)}`}. Confirm?` });
      continue;
    }
    // The resolver's suggestion when it escalated, else the gardener's (backlog 239).
    const num = (x: unknown) => typeof x === "number" || /^\d+$/.test(String(x ?? "")) ? Number(x) : undefined;
    const fromResolver = num((d.escalated as { suggested?: unknown } | undefined)?.suggested);
    const g = d.suggestion as { by?: string; choice?: unknown } | undefined;
    // On a private fact the owner sees no values here, so a one-word approve of the gardener's pick
    // would decide blind: he answers by number or in the dashboard (slice audit, 239).
    const suggested = fromResolver ?? (priv ? undefined : num(g?.choice));
    const suggested_by = fromResolver === undefined && suggested !== undefined ? g?.by : undefined;
    out.push({
      key: `dispute:${d.id}`, kind: "dispute", ref: d.id, private: priv, money, at: d.created || undefined,
      verbs: ["later"], suggested, suggested_by,
      options: priv ? undefined : d.candidates.map((c) => `${show(c.value)} (${c.as_of ?? "?"})`),
      waiting_on_resolver: d.status === "open" && !louisOnly && !!rules.policy.resolver,
      title: `Conflict ${d.id} on ${where}`,
    });
  }

  // Proposals waiting in inbox/.
  for (const p of proposals(root)) {
    const r = p.request as { id?: string; title?: string; type?: string; attribute?: string; value?: unknown; text?: string; sensitivity?: string; sources?: unknown[] };
    const target = noteFor(notes, r.id);
    // A proposal the capture pipeline wrote (a `capture:` field only proposeItem sets, from the
    // capture agent): its quote waits beside it (src/quotes.ts), and it counts like the reason
    // did when the quote lived there (G67).
    const pulled = p.by === captureAgent(rules) && isCaptureProposal(root, p.file);
    // Older proposals kept it in the reason; the digest moves those beside the proposal (G97).
    const quote = pulled ? getQuote(root, p.file) : undefined;
    // The quote is weighed like a value: someone's health, school or legal words, or money words,
    // make the item private, so neither value nor quote goes out (G93).
    const money = isMoney(target, r.id ?? "") || r.type === "money" || MONEY_WORDS.test(`${p.reason} ${quote ?? ""}`)
      || (!!quote && (categoryWords(rules.checks).money ?? []).some((w) => hasWord(quote, w)));
    const sensitive = !!quote && !!thirdPartySensitive({ agent: p.by, id: "people/quoted", value: quote } as never);
    // An assistant's reason that reads like health, money or legal: private, as the dashboard keeps
    // it behind Show it (G414).
    const why = !pulled && !!p.reason && !!sensitiveShape(rules, reasonText(String(p.reason)));
    const priv = isPrivate([target?.fm.sensitivity, r.sensitivity, rules.checks.types?.[r.type ?? ""]?.sensitivity]) || money || sensitive || why;
    const rawWhat = clean(`${r.id ?? r.title ?? "a new note"}${r.attribute ? `#${r.attribute}` : ""}`);
    const what = unsafe(rawWhat) ? "a note (name withheld)" : rawWhat;
    // Where it came from: the scheme of its first ref, only if it is a plain scheme name (G68).
    const scheme = pulled && Array.isArray(r.sources) ? String(r.sources[0] ?? "").split(":")[0] : "";
    const src = /^[a-z][a-z0-9-]{0,19}$/.test(scheme) ? scheme : pulled ? "a source" : "";
    const said = quote ? clean(quote) : "";
    const bare = src ? `From ${src}: ${short(what, 40)} = ${show(r.value ?? r.text)}` : `${p.by} proposes ${short(what, 40)} = ${show(r.value ?? r.text)}`;
    const quoted = src && said && !unsafe(said) ? `${bare} ("${short(said, 70)}")` : bare;
    // Each part was checked alone; an instruction split across them shows only on the whole line (G96).
    const line = !unsafe(quoted) ? quoted : !unsafe(bare) ? bare : `${src ? `From ${src}: a` : `${p.by} proposes a`} change to ${short(what, 40)} (withheld: reads as instructions)`;
    out.push({ key: `proposal:${p.file}`, kind: "proposal", ref: p.file, private: priv, money, at: p.at, verbs: ["later"],
      title: priv ? `${src ? `From ${src}: a` : `${p.by} proposes a`} change to a ${money ? "money" : "private"} note` : line });
  }

  // Agent mail the relay held. Never the subject or reasons: they can carry the held value. Nor an
  // outside sender's address: it is the sender's own text, read by the agent that relays texts.
  const named = (who: string) => who.split(/,\s*/).every((a) => a in rules.policy.agents) ? who : undefined;
  for (const m of comms(root).filter((x) => x.verdict === "held")) {
    const why = m.reasons.join(" ");
    const kind = /canary/.test(why) ? "a canary" : /contains (a |an )?(card|password|key|token|secret|iban|account|pin)/i.test(why) ? "a secret" : /contains "/.test(why) ? `a value ${m.to} can't see` : /withheld/.test(why) ? "a withheld topic" : /the message /.test(why) ? "instructions" : "a problem";
    out.push({ key: `mail:${m.id}`, kind: "mail", ref: m.id, private: /contains|canary/.test(why), money: /money|bank|card/i.test(why), at: m.at, verbs: ["later"],
      title: `Held mail ${named(m.from) ?? "an outside sender"} to ${named(m.to) ?? "an outside address"}: carries ${kind}. Release?` });
  }

  // Mail an agent asked to send (src/act.ts). Approved in the dashboard only (red team H1): a text
  // can reject it or put it off. Only owner- or hub-made strings (H3): the agent's label, the
  // label the owner gave the list entry, and a random code. Never the subject, why, body or address.
  for (const a of waitingActions(root)) {
    const label = clean(rules.policy.agents[a.agent]?.label ?? a.agent);
    // Both labels are free text (policy.yaml, the access-request label): the whole line gets the G96 check,
    // and a hit falls back to a line with no strings at all.
    const line = `${short(label, 30)} wants to send a mail to ${short(clean(a.entry_label), 40)} (code ${a.code}). Approve it in the dashboard`;
    out.push({ key: `action:${a.id}`, kind: "action", ref: a.id, code: a.code, private: true, money: false, at: a.at, verbs: ["reject", "later"],
      title: unsafe(line) ? `An assistant wants to send a mail (code ${a.code}). Approve it in the dashboard` : line });
  }

  // Captures held because they read like instructions. Never their words or the sender's address:
  // the text says only where it came in, and release needs the owner's own reply.
  const held = heldCaptures(root);
  const VIA: Record<string, string> = { mail: "the capture mailbox", drop: "your drop folder", cli: "the command line", import: "a memory import" };
  for (const c of held) {
    const from = c.via === "agent" ? clean(c.by ?? "an assistant") : VIA[c.via ?? ""] ?? "a capture channel";
    out.push({ key: `capture:${c.file}`, kind: "capture", ref: c.file, private: true, money: false, verbs: ["later"],
      title: `Held capture from ${unsafe(from) ? "an assistant" : short(from, 30)}: it reads like instructions. Release?` });
  }
  const heldFiles = held.map((c) => c.file);

  // Alerts (leak tripwire, relay alerts): urgent, acknowledged with ok. A held capture's alert is
  // the capture item above while it is still held.
  // One item per failing check (agent and check), its newest alert: a check that fails on every
  // retry is one problem, not one a day (owner's home page, 2026-10-25: "5 problems", one cause).
  const open = alertOpen(root);
  const recent = jsonl(join(root, "log", "alerts.jsonl")).filter((x) => String(x.at) >= since && open(x));
  const newest = new Map(recent.map((a) => [`${a.agent ?? ""}\u0000${a.check ?? ""}`, a]));
  for (const a of recent) {
    if (newest.get(`${a.agent ?? ""}\u0000${a.check ?? ""}`) !== a) continue;
    if (a.check === "capture_held" && heldFiles.some((f) => String(a.from ?? "").startsWith(f + " ") || String(a.from ?? "") === f)) continue;
    const who = String(a.agent ?? (a.from ? `${a.from} to ${a.to}` : "?"));
    out.push({ key: `alert:${hash(JSON.stringify(a))}`, kind: "alert", check: String(a.check ?? ""), ref: String(a.at), private: true, money: false, at: String(a.at), verbs: ["ok", "later"],
      title: `Alert (${a.check}): ${who}. Look in the dashboard` });
  }

  // Upkeep contradictions that aren't already a dispute.
  const latest = upkeepRuns(root)[0];
  if (latest && !latest.undone) for (const line of latest.escalate.filter((l) => !l.includes("[open-dispute]"))) {
    const key = line.match(/`([^`]+)`/)?.[1] ?? line.match(/\]\s*(\S+)/)?.[1] ?? "?";
    const rule = line.match(/\[([^\]]+)\]/)?.[1] ?? "upkeep";
    const n = noteFor(notes, key);
    out.push({ key: `upkeep:${hash(latest.run + line)}`, kind: "upkeep", ref: latest.run, private: isPrivate([n?.fm.sensitivity]), money: isMoney(n, key), verbs: ["ok", "later"],
      title: `Upkeep: ${rule} on ${isPrivate([n?.fm.sensitivity]) ? "a private note" : short(key, 40)}` });
  }

  // Model spend near or at its cap (src/usage.ts). The text goes through an agent, and agents
  // never learn about spending, so it says only that an account notice waits in the dashboard.
  const u = usageItem(root);
  if (u) out.push({ key: u.key, kind: "usage", ref: u.key, private: true, money: true, verbs: ["ok", "later"],
    title: u.state === "over" ? "Account notice, action needed: open the dashboard" : "Account notice: open the dashboard when you can" });

  // rules/ touched outside Louis: uncommitted edits, or a commit by an agent.
  const dirty = git(root, ["status", "--porcelain", "--", "rules"]).split("\n").filter(Boolean).map(porcelainPath);
  if (dirty.length) out.push({ key: `rules:dirty:${hash(dirty.join())}`, kind: "rules", ref: dirty.join(","), private: false, money: false, verbs: ["ok", "later"],
    title: `rules/ changed outside git: ${short(dirty.join(", "), 50)}. Was it you?` });
  const agents = new Set(Object.keys(rules.policy.agents));
  for (const l of git(root, ["log", "-n", "50", `--since=${since}`, "--format=%h %an", "--", "rules"]).split("\n").filter(Boolean)) {
    const [h, an] = l.split(" ");
    if (agents.has(an)) out.push({ key: `rules:${h}`, kind: "rules", ref: h, private: false, money: false, verbs: ["ok", "later"],
      title: `${an} committed to rules/ (${h}); agents never do. Revert it in the dashboard` });
  }
  // Last check on every whole line a text is built from, a dispute's options included: clean parts
  // can still join into instructions. Then only the kind of item goes, and the words stay in the dashboard.
  for (const it of out) {
    if (unsafe(it.title)) { it.title = `A ${it.kind} item waits: its words read like instructions. ${INSTEAD}`; it.options = undefined; }
    else if (it.options && unsafe(`${it.title}: ${it.options.map((o, i) => `${i + 1} ${o}`).join(" ")}`)) { it.options = undefined; it.private = true; }
  }
  return out;
}

// ---------- hub health ----------

export interface HealthResult { check: string; ok: boolean; detail: string }
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function healthChecks(root: string, p: EscalationPolicy, opts: { fetch?: Fetch; now?: Date } = {}): Promise<HealthResult[]> {
  const now = opts.now ?? new Date();
  const out: HealthResult[] = [];
  if (p.health.url) {
    const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
    let ok = false, detail = "";
    try {
      const r = await f(p.health.url, { signal: AbortSignal.timeout(5000) });
      ok = r.ok;
      detail = ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) { detail = String((e as Error).message ?? e).slice(0, 80); }
    out.push({ check: "server", ok, detail: ok ? "the agents' server answers" : `the agents' server doesn't answer (${detail})` });
  }
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
  const conflicted = git(root, ["diff", "--name-only", "--diff-filter=U"]).trim();
  out.push({ check: "git", ok: !!head && !conflicted, detail: !head ? "the brain repo has no HEAD" : conflicted ? `merge conflict in ${short(conflicted, 40)}` : "ok" });
  const runs = upkeepRuns(root);
  if (runs.length) {
    const m = runs[0].run.match(/^reflect-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const at = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : undefined;
    const hours = at ? (now.getTime() - at.getTime()) / 3_600_000 : 0;
    out.push({ check: "upkeep", ok: hours <= p.health.upkeep_stale_hours, detail: `upkeep last ran ${Math.round(hours)}h ago` });
  }
  const mb = freeMb(root);
  if (mb !== undefined) out.push({ check: "disk", ok: mb >= p.health.min_free_mb, detail: `${Math.round(mb)} MB free` });
  return out;
}

type FreeDisk = (root: string) => number | undefined;
let freeMb: FreeDisk = (root) => {
  try { const s = statfsSync(root); return (s.bavail * s.bsize) / 1_048_576; } catch { return undefined; /* statfs unsupported: skip */ }
};
// Tests swap in a fixed figure, so the check never depends on the test machine's disk.
export function useFreeDisk(f: FreeDisk) { freeMb = f; }
export const freeDiskMb = (root: string) => freeMb(root);

export function heartbeatFile(root: string) {
  return join(root, "textline", "heartbeat");
}
export function lastHeartbeat(root: string): string | undefined {
  const f = heartbeatFile(root);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
}
