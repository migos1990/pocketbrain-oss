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
  batch: { wait_minutes: number; max_wait_count: number; min_gap_minutes: number; max_items: number; max_chars: number };
  remind_after_hours: number;
  snooze_hours: number;
  // Open disputes the resolver (Instinct) may still settle wait this long before Louis hears.
  resolver_grace_minutes: number;
  health: { url?: string; failures_before_text: number; upkeep_stale_hours: number; min_free_mb: number };
  transport: TransportConfig;
  // The decision deck (docs/decision-deck.md): what the hub may decide when the owner doesn't
  // answer. Which items qualify is fixed in code (src/deck.ts); only the waits and the off
  // switch live here.
  auto_decide: { off: boolean; proposal_days: number };
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
  batch: { wait_minutes: 30, max_wait_count: 5, min_gap_minutes: 60, max_items: 5, max_chars: 480 },
  remind_after_hours: 12,
  snooze_hours: 4,
  resolver_grace_minutes: 60,
  health: { url: undefined, failures_before_text: 2, upkeep_stale_hours: 36, min_free_mb: 1024 },
  // Louis, 2026-10-08: Instinct only, no fallback. Twilio and iMessage stay in code, unused.
  transport: { use: "instinct" },
  auto_decide: { off: false, proposal_days: 14 },
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
    batch: { ...DEFAULTS.batch, ...(raw.batch ?? {}) },
    health: { ...DEFAULTS.health, ...(raw.health ?? {}) },
    transport: { ...DEFAULTS.transport, ...(raw.transport ?? {}) },
    auto_decide: autoDecide(raw.auto_decide),
  };
}

// Waits are clamped so a typo can't make the hub decide at once. Anything but a map (`auto_decide:
// off`, `false`, a list) means off, so a shorthand never leaves it on (G156).
function autoDecide(raw: unknown): EscalationPolicy["auto_decide"] {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return { ...DEFAULTS.auto_decide, off: true };
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, min: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : d);
  return { off: r.off === true || /^(yes|on|true)$/i.test(String(r.off ?? "")), proposal_days: num(r.proposal_days, DEFAULTS.auto_decide.proposal_days, 3) };
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

# The decision deck (docs/decision-deck.md). When you don't answer, the hub only lets an
# outside assistant's proposal expire (never private, money, health, legal or your own word);
# conflicts always wait for you. Logged, in the digest, one tap to undo.
auto_decide:
  off: false
  proposal_days: 14     # at least 3

transport:
  use: instinct         # the owner's choice: Instinct only. Its routine pulls texts every 5 minutes.
  # No fallback: if Instinct stops pulling, texts wait in the outbox and the daily digest
  # still lists everything. Unused options, kept in code (instinct | twilio | imessage | fake):
  # fallback: twilio
  # instinct: { stale_pull_minutes: 20 }
  # twilio: { from: "+15145550100", to: "+15145550199" }   # keys from env TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
  # imessage: { to: "+15145550199" }                       # runs on the Mac; needs Full Disk Access for replies
`;
