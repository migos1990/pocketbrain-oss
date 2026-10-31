// SPDX-License-Identifier: AGPL-3.0-only
// Handoffs (docs/handoffs.md, big bet 9): one assistant starts a task, another finishes it. A
// handoff is a task and a next step addressed to one agent. It is checked like relay mail against
// the recipient's slice (checkBetween), kept in handoffs/ (not a content folder, so no view,
// search or cell ever holds it), and shown to its recipient first by whats_new until the recipient
// marks it done. The sender gets the same answer whether it was delivered or held, so a handoff
// can't be used to test what the recipient may see. A trial agent's handoffs wait for the owner.
import { clock, ownerDay } from "./clock";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain, today } from "./brain";
import { loadRules, tierOf } from "./rules";
import { checkBetween, alertedHookHolds, loadRelayConfig, flagCategories, requestCheck, FLAG_STEP, type RelayConfig } from "./relay";
import { keyedModel } from "./aftercheck";
import type { Model } from "./model";
import { loadCanaries } from "./canary";
import { alert } from "./util";
import { redactSecrets, hardSecretIn } from "./checks";
import { putHeld, getHeld, dropHeld } from "./quotes";
import { git } from "./git";
import { OWNER } from "./owner";
import { tokenRole } from "./tokenrole";
import { CoreError } from "./core";

const MAX_TASK = 2000, MAX_STEP = 500, PER_DAY = 20;
const ID = /^ho-[0-9]{14}-[a-z0-9]{4}$/;

export interface Handoff { id: string; from: string; at: string; task: string; next_step: string }
interface Record_ { fm: Record<string, any>; task: string; file: string }

const text = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new CoreError(400, `a handoff needs ${what}`);
  // One line each: a newline could fake a second entry in whats_new.
  // C0 and C1 controls (NEL is U+0085) and Unicode line and paragraph separators all count (G192).
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  if (t.length > max) throw new CoreError(400, `${what} is too long (at most ${max} characters)`);
  return t;
};

// Text asking the recipient to keep something from the owner: never a fair handoff.
function secrecy(raw: string, ownerName?: string): boolean {
  const text = raw.replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'");
  const owner = `(owner|louis|robin${ownerName ? `|${ownerName.replace(/[^A-Za-z -]/g, "")}` : ""})`;
  return [
    `\\b(don'?t|do not|never|no need to|avoid)\\s+(tell|let|show|mention|inform|cc|copy|bring|loop|involve|ask|alert|notify)\\b[^.;]{0,40}\\b${owner}\\b`,
    `\\bwithout\\s+(telling|asking|letting|informing|involving|notifying|alerting)\\b[^.;]{0,30}\\b${owner}\\b`,
    `\\b(keep|hide)\\s+(this|it|that)\\b[^.;]{0,30}\\bfrom\\b`,
    `\\b(keep|leave)\\s+(the\\s+)?${owner}\\s+(out|in the dark|unaware)\\b`,
    `\\b(behind|over)\\s+(the\\s+)?${owner}'?s?\\s+(back|head)\\b`,
    `\\b(delete|remove|erase|destroy|discard)\\s+(this|the)\\s+handoff`,
  ].some((r) => new RegExp(r, "i").test(text));
}

function relayConfig(root: string): RelayConfig {
  try { return loadRelayConfig(root); } catch {
    const planted = loadCanaries(root);
    return { relay_address: "", agents: {}, canaries: [...planted.canaries, ...planted.retired] } as RelayConfig;
  }
}

function all(root: string): Record_[] {
  const dir = join(root, "handoffs");
  if (!existsSync(dir)) return [];
  const out: Record_[] = [];
  for (const day of readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const f of readdirSync(join(dir, day)).filter((x) => x.endsWith(".md")).sort()) {
      const m = readFileSync(join(dir, day, f), "utf8").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (m) out.push({ fm: YAML.parse(m[1]) ?? {}, task: m[2].trim(), file: join("handoffs", day, f) });
    }
  }
  // Oldest first by time (ids made in the same second sort randomly by name).
  return out.sort((a, b) => String(a.fm.at).localeCompare(String(b.fm.at)));
}

// G201: the record is committed, and the backup refuses plaintext secrets on main, so the agent's
// own words (task and next step) are redacted before they are written, and the record is then
// scanned whole: a key split between the two (its header in one, its body in the other) passes
// each alone, so then both are blanked. The checks ran on the raw text, so a handoff carrying a
// secret is still held with an alert; its original waits outside git (G243, `keepOriginal`).
// G280: the reasons quote the sender too (a money ask quotes a few of its words), so they are
// redacted like the rest; level 1 blanks the task and next step, level 2 the reasons as well.
const REMOVED = "[removed: secret-shaped]";
const recordText = (r: Record_, level: 0 | 1 | 2) => {
  const red = (t: string) => (level ? REMOVED : redactSecrets(t).text);
  const fm: Record<string, unknown> = { ...r.fm };
  if (typeof r.fm.next_step === "string") fm.next_step = red(r.fm.next_step);
  if (Array.isArray(r.fm.reasons)) fm.reasons = r.fm.reasons.map((x: unknown) => (level === 2 ? REMOVED : redactSecrets(String(x)).text));
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${red(r.task)}\n`;
};
// The least blanking that leaves no hard secret in the record.
const safeRecord = (r: Record_) => {
  const a = recordText(r, 0); if (!hardSecretIn(a)) return a;
  const b = recordText(r, 1); if (!hardSecretIn(b)) return b;
  const c = recordText(r, 2);
  // The last level holds only what the hub wrote (id, agents, times); checked all the same (G314).
  if (hardSecretIn(c)) throw new Error("handoff: the record still held a secret shape after every field the sender wrote was blanked");
  return c;
};
function save(root: string, r: Record_, message: string, author: string, withLog = false) {
  mkdirSync(join(root, r.file, ".."), { recursive: true });
  writeFileSync(join(root, r.file), safeRecord(r));
  git(root, ["add", r.file, ...(withLog && existsSync(join(root, "log")) ? ["log"] : [])]);
  git(root, ["commit", "-q", "-m", message], author);
}

// One handoff from `from` (the authenticated caller) to another outside agent. When the owner has
// turned the relay's request check on (`relay: { classify: true }`, G26), a handoff between agents
// where a side has a withheld category is also read by that model, as relay mail is: a hit, or an
// answer it can't give, holds it. The reply never waits for the model: the handoff is kept as
// "checking" (nobody sees it) and the verdict lands when the check ends (`settled`), so how long
// the reply takes says nothing about what the check found. `model` is for tests and evals; null
// turns the check off.
export async function handOff(root: string, from: string, req: { to: unknown; task: unknown; next_step: unknown }, opts: { model?: Model | null; lock?: <T>(fn: () => T) => Promise<T> } = {}): Promise<{ id: string; reply: string; settled: Promise<void> }> {
  const rules = loadRules(root);
  const agents = rules.policy.agents;
  // Own keys only: "__proto__" or "constructor" is never an agent (G190).
  const agentNamed = (a: string) => (Object.hasOwn(agents, a) ? agents[a] : undefined);
  const me = agentNamed(from);
  if (!me || me.inside_wall || me.role === "gardener" || tokenRole(from) === "resolver") throw new CoreError(403, `${from} can't hand off work`);
  if (me.status === "paused") throw new CoreError(403, `${from} is paused by the owner`);
  if (me.status === "read-only") throw new CoreError(403, `${from} is read-only: it can't hand off work`);
  if (typeof req.to !== "string") throw new CoreError(400, "to is the agent that takes over, by name");
  const to = req.to.trim().toLowerCase();
  const them = agentNamed(to);
  if (!them || them.inside_wall || them.role === "gardener") throw new CoreError(400, `${to} is not an agent that can take a handoff`);
  if (to === from) throw new CoreError(400, "you can't hand off to yourself");
  const task = text(req.task, "a task", MAX_TASK), next_step = text(req.next_step, "a next step", MAX_STEP);

  // The owner's clock (src/clock.ts); a pinned PB_TODAY (tests, as for as_of) keeps the clock's time
  // on that day, so the id, the date whats_new shows and the folder all agree with the brain's today.
  const now = process.env.PB_TODAY ? new Date(`${process.env.PB_TODAY}${clock().toISOString().slice(10)}`) : clock();
  const id = `ho-${now.toISOString().replace(/[-:TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
  const v = checkBetween(loadBrain(root), rules, relayConfig(root), id, from, to, `${task}\n${next_step}`);
  const reasons = [...v.reasons];
  let deliver = v.deliver;
  const hold = (why: string) => { deliver = false; reasons.push(why); };
  const mine = all(root).filter((r) => r.fm.from === from);
  if (deliver && secrecy(`${task} ${next_step}`, rules.policy.owner?.name)) hold("asks to keep something from the owner");
  // Delivered-or-not is something a colluding recipient can see, so one alerted hold stops this
  // sender's handoffs until the owner decides on it (as for the relay hook, G51), and a day has a cap.
  // One hit across channels: a relay-hook message held with an alert counts too (G189).
  if (deliver && (mine.some((r) => r.fm.verdict === "held" && r.fm.alert === true) || alertedHookHolds(root, from).length)) hold(`${from} has a message held with an alert; the owner decides on that one first`);
  const today_ = ownerDay(rules, now); // the owner's day (src/clock.ts)
  if (deliver && mine.filter((r) => !!r.fm.at && ownerDay(rules, r.fm.at instanceof Date ? r.fm.at : String(r.fm.at)) === today_).length >= PER_DAY) hold(`${from} handed off ${PER_DAY} tasks today already`);
  if (deliver && tierOf(rules, from).writes === "propose") hold(`${from} is a trial agent: the owner sees its handoffs first`);
  const on = opts.model !== null && (opts.model !== undefined || rules.policy.relay?.classify === true);
  const model = deliver && on && flagCategories(rules, v).length ? opts.model ?? keyedModel(root, FLAG_STEP, "relay") : undefined;
  if (v.alert) alert(root, { check: "handoff", from, to, reasons });
  const fm: Record<string, unknown> = { id, type: "handoff", from, to, at: now.toISOString(), verdict: model ? "checking" : deliver ? "delivered" : "held", ...(reasons.length ? { reasons } : {}), ...(v.alert ? { alert: true } : {}), next_step, status: "open" };
  const file = join("handoffs", process.env.PB_TODAY ?? today_, `${id}.md`);
  // Saved before anything is awaited, so the cap and the sticky hold count this one at once.
  // When the record has to be redacted, the original waits outside git for the owner (G243).
  const rec = { fm, task, file };
  // A delivered one keeps none (G285): the recipient reads the record, and nothing releases it.
  if (fm.verdict !== "delivered" && safeRecord(rec) !== `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${task}\n`) putHeld(root, `handoff-${id}`, { task, next_step });
  save(root, rec, `handoff: ${from} -> ${to} ${fm.verdict}`, "relay", true);
  const settled = model ? settle(root, id, opts.lock ?? (async (fn) => fn()), async () => requestCheck(root, loadBrain(root), rules, model, { id, from, to: [to], subject: "", text: `${task}\n${next_step}` }, v)) : Promise.resolve();
  return { id, reply: `Handed off to ${to} (handoff id: ${id}). ${to} sees it the next time it checks what's new; the owner may look at it first.`, settled };
}

// Handoffs whose request check is running in this process. One kept as "checking" that isn't here
// was left by a restart, and settleLeftovers finishes it.
const inflight = new Set<string>();
export function forgetInflight() { inflight.clear(); }

// The request check's verdict on a handoff kept as "checking": delivered, or held with why.
async function settle(root: string, id: string, lock: <T>(fn: () => T) => Promise<T>, check: () => Promise<string | undefined>): Promise<void> {
  inflight.add(id);
  try { await settleNow(root, id, lock, check); } finally { inflight.delete(id); }
}
async function settleNow(root: string, id: string, lock: <T>(fn: () => T) => Promise<T>, check: () => Promise<string | undefined>): Promise<void> {
  let why: string | undefined;
  try { why = await check(); } catch (e) {
    console.error(`handoff: request check on ${id}: ${(e as Error).message}`);
    why = "the request check couldn't read this handoff, so the owner decides";
  }
  // The hub's write lock (serial) around the commit only, never around the model call.
  await lock(() => {
    const r = all(root).find((x) => x.fm.id === id);
    if (!r || r.fm.verdict !== "checking") return;
    r.fm.verdict = why ? "held" : "delivered";
    if (why) r.fm.reasons = [...(r.fm.reasons ?? []), why];
    save(root, r, `handoff: ${id} ${r.fm.verdict} by the request check`, "relay");
    if (!why) dropHeld(root, `handoff-${id}`); // delivered: nothing will release it (G285)
  });
}

// Handoffs left "checking" by a hub restart (nobody sees one in that state): checked again with the
// relay.flag model when it is keyed, else held for the owner. Run when the hub starts and in the
// night pass. Returns how many it settled.
export async function settleLeftovers(root: string, opts: { model?: Model | null; lock?: <T>(fn: () => T) => Promise<T> } = {}): Promise<number> {
  const left = all(root).filter((r) => r.fm.verdict === "checking" && !inflight.has(r.fm.id));
  if (!left.length) return 0;
  const rules = loadRules(root);
  const model = opts.model === null ? undefined : opts.model ?? keyedModel(root, FLAG_STEP, "relay");
  const lock = opts.lock ?? (async <T>(fn: () => T) => fn());
  for (const r of left) {
    const { id, from, to } = r.fm, text = `${r.task}\n${r.fm.next_step}`;
    await settleNow(root, id, lock, async () => {
      if (!model) return "the request check didn't finish (the hub restarted), so the owner decides";
      const v = checkBetween(loadBrain(root), rules, relayConfig(root), id, from, to, text);
      if (!v.deliver) return v.reasons[0] ?? "held by the relay checks";
      return requestCheck(root, loadBrain(root), rules, model, { id, from, to: [to], subject: "", text }, v);
    });
  }
  return left.length;
}

// What waits for this agent: delivered or owner-released, not yet done. Never names the sender.
// A delivered one is checked again now, in the reader's request: its token's cap (a reader token)
// and its slice as it is today, so a later narrowing hides it too. An owner-released one isn't for the slice,
// the owner chose to show it to the agent, so only a reader token's cap still applies.
export function openHandoffs(root: string, agent: string): Handoff[] {
  const rules = loadRules(root);
  const a = rules.policy.agents[agent];
  if (!a || a.inside_wall || a.status === "paused" || a.role === "gardener") return [];
  const mine = all(root).filter((r) => r.fm.to === agent && r.fm.status === "open" && (r.fm.verdict === "delivered" || r.fm.verdict === "released-by-owner"));
  if (!mine.length) return [];
  const notes = loadBrain(root), cfg = relayConfig(root);
  const reader = tokenRole(agent) === "reader";
  return mine.filter((r) => (r.fm.verdict === "released-by-owner" && !reader) || checkBetween(notes, rules, cfg, r.fm.id, r.fm.from, agent, `${r.task}\n${r.fm.next_step}`).deliver)
    .map((r) => {
      // A released one shows what the sender wrote, kept outside git while it was held (G243).
      const orig = r.fm.verdict === "released-by-owner" ? getHeld(root, `handoff-${r.fm.id}`) : undefined;
      return { id: r.fm.id, from: "an assistant", at: r.fm.at, task: orig?.task ?? r.task, next_step: orig?.next_step ?? r.fm.next_step };
    });
}

// Closing keeps no note: nothing checks it, and nobody would read it.
export function finishHandoff(root: string, agent: string, id: unknown): string {
  const r = typeof id === "string" && ID.test(id) ? all(root).find((x) => x.fm.id === id) : undefined;
  if (!r || r.fm.to !== agent || !(r.fm.verdict === "delivered" || r.fm.verdict === "released-by-owner")) return `${String(id).slice(0, 40)}: not yours, or no such handoff`;
  if (r.fm.status === "done") return `${id}: already done`;
  // Marking done commits as the agent, so a paused or read-only one can't (G191).
  const st = loadRules(root).policy.agents[agent]?.status;
  if (st === "paused" || st === "read-only") throw new CoreError(403, `${agent} is ${st === "paused" ? "paused by the owner" : "read-only"}: it can't mark a handoff done`);
  r.fm.status = "done";
  r.fm.done = today();
  save(root, r, `handoff: ${id} done by ${agent}`, agent);
  dropHeld(root, `handoff-${id}`);
  return `${id}: done`;
}

// The owner's decision on a held handoff: release shows it to its recipient, drop keeps it out.
export function decideHandoff(root: string, id: string, decision: "release" | "drop"): string {
  const r = ID.test(id) ? all(root).find((x) => x.fm.id === id) : undefined;
  if (!r) return `no handoff ${id.slice(0, 40)}`;
  if (r.fm.verdict !== "held") return `${id} is ${r.fm.verdict}, not held`;
  r.fm.verdict = decision === "release" ? "released-by-owner" : "dropped-by-owner";
  r.fm.decided = today();
  save(root, r, `handoff: ${id} ${r.fm.verdict}`, OWNER);
  if (decision === "drop") dropHeld(root, `handoff-${id}`);
  return `${id}: ${r.fm.verdict}`;
}

// For the owner: held handoffs first, then open ones.
export function listHandoffs(root: string): string {
  // A handoff the owner dropped stays out (docs/handoffs.md).
  const rows = all(root).filter((r) => r.fm.verdict === "held" || (r.fm.status === "open" && r.fm.verdict !== "dropped-by-owner")).sort((a, b) => (a.fm.verdict === "held" ? 0 : 1) - (b.fm.verdict === "held" ? 0 : 1));
  if (!rows.length) return "No handoffs held or open.";
  return rows.map((r) => `${r.fm.id}  ${r.fm.from} -> ${r.fm.to}  ${r.fm.verdict}${r.fm.verdict === "held" ? ` (${(r.fm.reasons ?? []).join("; ")})` : `, ${r.fm.status}`}\n  ${r.task.slice(0, 120)}`).join("\n");
}

// Held handoffs for the owner's digest.
export function heldHandoffs(root: string): { id: string; from: string; to: string; why: string }[] {
  return all(root).filter((r) => r.fm.verdict === "held").map((r) => ({ id: r.fm.id, from: r.fm.from, to: r.fm.to, why: (r.fm.reasons ?? [])[0] ?? "" }));
}
