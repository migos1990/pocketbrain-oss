// SPDX-License-Identifier: AGPL-3.0-only
// rules/escalation.yaml: when the text channel texts Louis, and how. Only Louis edits it.
// Every field has a default, so a brain without the file still gets sane behaviour.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export type Tier = "urgent" | "normal" | "low";
export type Kind = "health" | "alert" | "rules" | "dispute" | "held-answer" | "mail" | "capture" | "proposal" | "upkeep" | "usage" | "action";

export interface EscalationPolicy {
  cadence_minutes: number;
  // Which tier each kind of open item starts in. urgent: texted at once, even in quiet hours.
  // normal: batched. low: never texted on its own; rides along when a text goes anyway.
  tiers: Record<Kind, Tier>;
  // Private or money items always reach Louis: never low, never waiting on the resolver.
  // Their values never travel by text; the text says where to decide.
  always_escalate: { private: boolean; money: boolean };
  quiet_hours?: { from: string; to: string; tz: string };
  // style line (the default): one line, the home page's count, "open your home"; the hub's own
  // alerts are never texted (owner, 2026-10-24: "73 need you", a list of alerts). list: one line per
  // item with a letter; a reply puts it off or clears an alert, never decides it (outside review v5).
  batch: { style: "line" | "list"; wait_minutes: number; max_wait_count: number; min_gap_minutes: number; max_items: number; max_chars: number };
  remind_after_hours: number;
  snooze_hours: number;
  // Open disputes the resolver (Instinct) may still settle wait this long before Louis hears.
  resolver_grace_minutes: number;
  health: { url?: string; failures_before_text: number; upkeep_stale_hours: number; min_free_mb: number };
  transport: TransportConfig;
  // The hub's filing (docs/filing.md): what the hub may decide when the owner doesn't answer.
  // Which items qualify is fixed in code (src/filing.ts); only the waits and the off switch live here.
  // file: "all" (owner, 2026-10-25: "facts to be approved should be when there's conflict"): every
  // fact a capture or source pull proposed files itself; only a conflict waits (src/filing.ts fileVerdict).
  // hold_assistants_until: the owner's day a hold on core assistants' own proposals ends (a
  // YYYY-MM-DD); before it they wait with a diary line, from it they file by the usual rules. No
  // hold unless the owner sets one (re-audit 2026-10-30, G531: it was a date hard-coded in src/filing.ts).
  auto_decide: { off: boolean; proposal_days: number; source_saves_per_day: number; file?: "all"; hold_assistants_until?: string };
}

export interface TransportConfig {
  use: "instinct" | "twilio" | "imessage" | "fake";
  // Used when the primary can't send (an error, or Instinct hasn't pulled for too long).
  fallback?: "twilio" | "imessage" | "fake";
  instinct?: { push_url?: string; stale_pull_minutes?: number };
  twilio?: { from: string; to: string };
  imessage?: { to: string; chat_db?: string };
  // fake: replies from it count as Louis's own (true) or as relayed (false), for tests.
  fake?: { trusted?: boolean };
}

export const DEFAULTS: EscalationPolicy = {
  cadence_minutes: 5,
  tiers: { health: "urgent", alert: "urgent", rules: "urgent", dispute: "normal", "held-answer": "normal", mail: "normal", capture: "normal", proposal: "normal", upkeep: "low", usage: "normal", action: "normal" },
  always_escalate: { private: true, money: true },
  quiet_hours: { from: "22:00", to: "07:30", tz: "America/Toronto" },
  batch: { style: "line", wait_minutes: 30, max_wait_count: 5, min_gap_minutes: 60, max_items: 5, max_chars: 480 },
  remind_after_hours: 12,
  snooze_hours: 4,
  resolver_grace_minutes: 60,
  health: { url: undefined, failures_before_text: 2, upkeep_stale_hours: 36, min_free_mb: 1024 },
  // Louis, 2026-10-08: Instinct only, no fallback. Twilio and iMessage stay in code, unused.
  transport: { use: "instinct" },
  auto_decide: { off: false, proposal_days: 14, source_saves_per_day: 0, file: "all" },
};

export function loadEscalation(root: string): EscalationPolicy {
  const f = join(root, "rules", "escalation.yaml");
  const raw = (existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) : {}) ?? {};
  return {
    ...DEFAULTS,
    ...raw,
    tiers: { ...DEFAULTS.tiers, ...(raw.tiers ?? {}) },
    always_escalate: { ...DEFAULTS.always_escalate, ...(raw.always_escalate ?? {}) },
    quiet_hours: raw.quiet_hours === null ? undefined : { ...DEFAULTS.quiet_hours!, ...(raw.quiet_hours ?? {}) },
    batch: { ...DEFAULTS.batch, ...(raw.batch ?? {}), style: raw.batch?.style === "list" ? "list" : "line" },
    health: { ...DEFAULTS.health, ...(raw.health ?? {}) },
    transport: { ...DEFAULTS.transport, ...(raw.transport ?? {}) },
    auto_decide: autoDecide(raw.auto_decide),
  };
}

// Waits are clamped so a typo can't make the hub decide at once. Anything but a map (`auto_decide:
// off`, `false`, a list) means off, so a shorthand never leaves it on (G156).
// file: all is the default (owner's outside review, 2026-10-25: "nobody approves facts"); `file: ask`
// leaves each fact waiting on the overview (G422).
function autoDecide(raw: unknown): EscalationPolicy["auto_decide"] {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return { ...DEFAULTS.auto_decide, off: true };
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, min: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : d);
  // source_saves_per_day: low-risk calendar and mail facts the hub saves for the owner each day
  // (src/filing.ts). Off (0) until the owner sets it: a new job starts report-only.
  // A hold that isn't a real day is no hold: a typo never holds every proposal for good.
  const h = r.hold_assistants_until instanceof Date ? r.hold_assistants_until.toISOString().slice(0, 10) : String(r.hold_assistants_until ?? "");
  const hold = /^\d{4}-\d{2}-\d{2}$/.test(h) && Number.isFinite(Date.parse(h)) ? { hold_assistants_until: h } : {};
  return { off: r.off === true || /^(yes|on|true)$/i.test(String(r.off ?? "")), proposal_days: num(r.proposal_days, DEFAULTS.auto_decide.proposal_days, 3), source_saves_per_day: Math.floor(num(r.source_saves_per_day, DEFAULTS.auto_decide.source_saves_per_day, 0)), ...(r.file === "ask" ? {} : { file: "all" as const }), ...hold };
}

// Minutes since midnight in the policy's time zone.
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };

export function inQuietHours(p: EscalationPolicy, now: Date): boolean {
  if (!p.quiet_hours) return false;
  const t = localMinutes(now, p.quiet_hours.tz), a = hm(p.quiet_hours.from), b = hm(p.quiet_hours.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export const ESCALATION_TEMPLATE = `# When pocketBrain texts the owner (the text channel). Only the owner edits this file.
# A poller runs every cadence_minutes on the hub, gathers what needs him, and texts
# once per batch. He answers with one word per item: approve, reject, later (or a number).
cadence_minutes: 5

# urgent: texted at once, even in quiet hours. normal: batched. low: rides along only.
tiers:
  health: urgent        # hub down, disk nearly full, upkeep not running
  alert: urgent         # canary seen, secret or injection in agent mail, leak tripwire
  rules: urgent         # rules/ changed by anyone but the owner
  dispute: normal       # a conflict the resolver couldn't settle
  held-answer: normal   # an answer relayed for a private fact, waiting for his confirmation
  mail: normal          # agent-to-agent mail held by the relay
  capture: normal       # a capture held because it reads like instructions (never its words)
  proposal: normal      # a write waiting in inbox/
  upkeep: low           # upkeep contradictions not already a dispute
  usage: normal         # model spend near or at its cap (the text says only "account notice")

# Private or money items always reach the owner (never low, never waiting on the resolver).
# Their values never go into a text: the text says to decide in the dashboard.
always_escalate: { private: true, money: true }

quiet_hours: { from: "22:00", to: "07:30", tz: America/Toronto }

batch:
  style: line           # line: "pocketBrain: 3 waiting on you, open your home". list: one lettered line per item (a reply puts off or clears, never decides)
  wait_minutes: 30      # a normal item waits up to this long for others to join it
  max_wait_count: 5     # ...or until this many are waiting
  min_gap_minutes: 60   # at most one normal text per hour
  max_items: 5          # the rest: "+N more in the dashboard"
  max_chars: 480        # three SMS segments

remind_after_hours: 12  # an unanswered item comes back after this
snooze_hours: 4         # what "later" means
resolver_grace_minutes: 60   # Instinct tries first on open disputes (architecture 0.6)

health:
  url: http://127.0.0.1:8787/health
  failures_before_text: 2
  upkeep_stale_hours: 36
  min_free_mb: 1024

# The hub's filing (docs/filing.md). When you don't answer, the hub lets an outside
# assistant's proposal expire, and saves a low-risk calendar or mail fact for you (never about a
# person, private, money, health, legal or your own word); conflicts always wait for you.
# Logged, in the digest, one tap to undo.
auto_decide:
  off: false
  proposal_days: 14     # at least 3
  source_saves_per_day: 0    # off; 20 saves up to 20 low-risk calendar and mail facts a day for you
  # file: all          # every fact your captures and sources find files itself, with Undo; only a conflict asks you (pocketbrain filing all on)
  # hold_assistants_until: 2026-11-30   # your core assistants' own proposals wait until that day, then file by the usual rules

transport:
  use: instinct         # the owner's choice: Instinct only. Its routine pulls texts every 5 minutes.
  # No fallback: if Instinct stops pulling, texts wait in the outbox and the daily digest
  # still lists everything. Unused options, kept in code (instinct | twilio | imessage | fake):
  # fallback: twilio
  # instinct: { stale_pull_minutes: 20 }
  # twilio: { from: "+15145550100", to: "+15145550199" }   # keys from env TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
  # imessage: { to: "+15145550199" }                       # runs on the Mac; needs Full Disk Access for replies
`;

// `pocketbrain textline use` (backlog #232): the owner switches the transport with one command
// instead of a hand YAML edit. Only the transport: block of rules/escalation.yaml changes (the
// rest of the file, comments included, stays byte for byte); the caller commits it as the owner.
// The handle goes into the file and nowhere else: never into output or a commit message.
export const TRANSPORTS = ["instinct", "imessage", "fake"] as const;
const HANDLE = /^(\+[1-9]\d{6,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

export function useTransport(text: string, use: string, to?: string): string {
  if (!(TRANSPORTS as readonly string[]).includes(use)) throw new Error(`transport must be ${TRANSPORTS.join(", ")}; twilio is set by hand in rules/escalation.yaml`);
  if (to !== undefined && !HANDLE.test(to)) throw new Error("the handle must be a phone in +E.164 form or an email address");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^transport:/.test(l));
  const prior = start < 0 ? {} : (YAML.parse(lines.slice(start).join("\n"))?.transport ?? {});
  if (use === "imessage" && !(to ?? prior.imessage?.to)) throw new Error("imessage needs the handle to text: --to <handle>, or --to - to read it from stdin");
  let end = start < 0 ? lines.length : start + 1;
  if (start >= 0) while (end < lines.length && (lines[end] === "" || /^[\s#]/.test(lines[end]))) end++;
  const doc = YAML.parseDocument(start < 0 ? "transport: {}\n" : lines.slice(start, end).join("\n"));
  doc.setIn(["transport", "use"], use);
  const node = doc.getIn(["transport", "use"], true) as { comment?: string | null } | undefined;
  if (node) node.comment = ` set by \`pocketbrain textline use\``;
  if (to !== undefined) doc.setIn(["transport", "imessage", "to"], to);
  const block = doc.toString().replace(/\n+$/, "").split("\n");
  const out = start < 0 ? [...lines.slice(0, lines.length - (lines.at(-1) === "" ? 1 : 0)), "", ...block, ""] : [...lines.slice(0, start), ...block, ...lines.slice(end).length ? ["", ...lines.slice(end)] : [""]];
  const next = out.join("\n");
  YAML.parse(next);
  return next;
}
