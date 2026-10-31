// SPDX-License-Identifier: AGPL-3.0-only
// Per-agent write quality (backlog 298): which assistant writes badly. Over the last 30 days, the
// agent's own committed writes the owner kept, corrected (the owner set that fact again, or marked
// it never right, after the write) or reverted (the commit was undone), and its proposals the owner
// accepted or rejected. Below the floor, with enough to judge, the hub suggests making it a trial
// agent so its writes wait for the owner. It only suggests: the tier is in rules/, the owner's.
// Source proposals have their own measure (fill quality, src/fill.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { CONTENT_DIRS } from "./brain";
import { git } from "./git";
import { loadRules, type Rules } from "./rules";
import { readJsonl } from "./util";

export const KEEP_FLOOR = 0.7, MIN_JUDGED = 10, WINDOW_DAYS = 30;
// A write and the commit that made it are seconds apart; this much leeway matches them.
const SAME_WRITE_MS = 120_000;

export interface WriteQuality {
  agent: string; days: number;
  writes: number; kept: number; corrected: number; reverted: number;
  accepted: number; rejected: number;
  judged: number; keepRate?: number; suggestTrial: boolean;
}

interface LogEntry { at?: string; agent?: string; kind?: string; op?: string; key?: string; outcome?: string }
interface Decided { decided?: string; decision?: string; request?: { agent?: string } }

const noteOf = (key: string) => key.split("#")[0];

// The dashboard passes the write log and rules it already holds (`log`, `rules`).
export function writeQuality(root: string, agent: string, o: { now?: Date; days?: number; log?: LogEntry[]; rules?: Rules } = {}): WriteQuality {
  const days = o.days ?? WINDOW_DAYS;
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const log = o.log ?? readJsonl<LogEntry>(join(root, "log", "writes.jsonl"));
  const mine = log.filter((w) => w.agent === agent && w.outcome === "committed" && (w.kind ?? "fact") === "fact" && w.key && String(w.at) >= since);
  const ownerEdits = log.filter((e) => e.kind === "owner-edit" && (e.op === "set" || e.op === "never-right") && e.key);

  // The agent's commits a later revert undid, with the notes each touched.
  const undone = new Set(git(root, ["log", "--format=%b", "--grep", "^This reverts commit "]).match(/[0-9a-f]{40}/g) ?? []);
  const reverts: { at: number; notes: Set<string> }[] = [];
  if (undone.size) {
    const out = git(root, ["log", "--no-merges", `--since=${since}`, "--format=\x1e%H\x1f%an\x1f%aI", "--name-only", "--", ...CONTENT_DIRS]);
    for (const rec of out.split("\x1e").filter((x) => x.trim())) {
      const [head, ...files] = rec.split("\n");
      const [hash, author, at] = head.split("\x1f");
      if (author === agent && undone.has(hash)) reverts.push({ at: Date.parse(at), notes: new Set(files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))) });
    }
  }

  let kept = 0, corrected = 0, reverted = 0;
  for (const w of mine) {
    const at = Date.parse(String(w.at));
    if (reverts.some((r) => r.notes.has(noteOf(w.key!)) && Math.abs(r.at - at) <= SAME_WRITE_MS)) reverted++;
    else if (ownerEdits.some((e) => String(e.at) >= String(w.at) && (e.key === w.key || (!w.key!.includes("#") && noteOf(e.key!) === w.key)))) corrected++;
    else kept++;
  }

  let accepted = 0, rejected = 0;
  const dir = join(root, "inbox", "decided");
  const day = since.slice(0, 10);
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    let p: Decided;
    try { p = YAML.parse(readFileSync(join(dir, f), "utf8")) ?? {}; } catch { continue; }
    if (p.request?.agent !== agent || !p.decided || String(p.decided).slice(0, 10) < day) continue;
    if (p.decision === "accept") accepted++; else if (p.decision === "reject") rejected++;
  }

  const judged = mine.length + accepted + rejected;
  const keepRate = judged ? (kept + accepted) / judged : undefined;
  const a = (o.rules ?? loadRules(root)).policy.agents[agent];
  const suggestTrial = !!a && a.tier !== "trial" && !a.inside_wall && a.role !== "gardener" && judged >= MIN_JUDGED && (keepRate ?? 1) < KEEP_FLOOR;
  return { agent, days, writes: mine.length, kept, corrected, reverted, accepted, rejected, judged, ...(keepRate === undefined ? {} : { keepRate }), suggestTrial };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// One line, for the agent's dashboard page and the week report.
export function qualityText(q: WriteQuality): string {
  if (!q.judged) return `nothing written in ${q.days} days`;
  return `${plural(q.writes, "write")} in ${q.days} days: ${q.kept} kept, ${q.corrected} corrected, ${q.reverted} reverted; ${plural(q.accepted + q.rejected, "proposal")}: ${q.accepted} accepted, ${q.rejected} rejected (${Math.round((q.keepRate ?? 0) * 100)}% kept)`;
}

export function trialText(q: WriteQuality, label = q.agent): string {
  return `Under ${KEEP_FLOOR * 100}% over ${q.judged}: consider making ${label} a trial agent, so its writes wait for you (tier: trial in rules/policy.yaml). The hub won't change it.`;
}

// The week report's section: every outside assistant that wrote or proposed anything in 30 days.
export function qualityLines(root: string, now = new Date()): string[] {
  const rules = loadRules(root);
  const qs = Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall && a.role !== "gardener").map(([n]) => writeQuality(root, n, { now })).filter((q) => q.judged);
  if (!qs.length) return [];
  const out = ["## Agent write quality", "", `Last ${WINDOW_DAYS} days; kept counts writes kept as written and proposals accepted.`, ""];
  for (const q of qs) out.push(`- ${q.agent}: ${qualityText(q)}${q.suggestTrial ? `. **${trialText(q)}**` : ""}`);
  return [...out, ""];
}
