// SPDX-License-Identifier: AGPL-3.0-only
// The daily digest (architecture 0.4: under 10 minutes a day for Louis). What needs him
// comes first, then what happened on its own, then the numbers from write-quality.md 7.
import { inboxCards } from "./write";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain, today, isDisputed } from "./brain";
import { loadRules } from "./rules";
import { carve, grantFor } from "./carve";
import { ownerMessagesPath } from "./louis";
import { git } from "./git";
import { readJsonl } from "./util";
import { morningNote } from "./sleep";
import { digestLines, openTasks } from "./measure";
import { failingChecks, selfCheckLine } from "./probe";
import { usageDigest } from "./usage";
import { suggestStanding, orphanStanding, standingProblem } from "./standing";
import { pullSummary } from "./pull";
import { fillLine } from "./fill";
import { state as memsyncState, oneLine } from "./memsync";
import { examLines } from "./exam";
import { scorecardLine } from "./scorecard";
import { auditDigestLine } from "./audit";
import { shareLines } from "./share";
import { heldHandoffs } from "./handoff";
import { migrateLegacyQuotes, sweepQuotes } from "./quotes";
import { autoDigestLines } from "./deck";

const jsonl = (file: string) => readJsonl(file);
// How much of a proposal's value and reason the digest prints (G92); the inbox file holds the rest.
const DIGEST_VALUE = 120, DIGEST_REASON = 300;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function digest(root: string, since?: string): { file: string; text: string; needsLouis: number } {
  const d = today();
  migrateLegacyQuotes(root); // quotes older proposals kept in their reason (G97)
  sweepQuotes(root); // quotes of proposals gone some other way than a decision (src/quotes.ts)
  const from = since ?? new Date(Date.now() - 86_400_000).toISOString();
  const notes = loadBrain(root);
  const rules = loadRules(root);
  const out: string[] = [`# pocketBrain digest, ${d}`, ""];
  const need: string[] = [];

  // Disputes waiting for Louis.
  for (const n of notes) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (!isDisputed(f)) continue;
    need.push(`- **Dispute ${f.dispute}** on \`${n.fm.id}#${attr}\`: ${f.candidates.map((c, i) => `(${i + 1}) ${typeof c.value === "object" ? JSON.stringify(c.value) : c.value} [${c.verification}, ${c.as_of}]`).join(" vs ")}. Answer with the number.`);
  }
  // Answers the resolver relayed on private facts wait for Louis.
  for (const n of notes.filter((x) => x.fm.type === "dispute" && x.fm.status === "answer-held")) {
    const a = n.fm.answer as { value: unknown; relayed_by: string; message_id: string };
    need.push(`- **Relayed answer** ${n.fm.id.split("/")[1]} on \`${n.fm.fact_key}\`: ${a.relayed_by} says you chose ${JSON.stringify(a.value)} (${a.message_id}). \`dispute --confirm\` or \`--reject\`.`);
  }
  // Relay messages held.
  const comms = join(root, "comms");
  if (existsSync(comms)) for (const day of readdirSync(comms)) for (const f of readdirSync(join(comms, day))) {
    const fm = YAML.parse(readFileSync(join(comms, day, f), "utf8").split("\n---\n")[0].replace(/^---\n/, ""));
    if (fm?.verdict === "held") need.push(`- **Held message** ${f.replace(/\.md$/, "")}, ${fm.from} to ${fm.to}, "${fm.subject}": ${(fm.reasons ?? [])[0] ?? ""}. \`relay --release\` or \`--drop\`.`);
  }
  // Handoffs held (src/handoff.ts).
  for (const h of heldHandoffs(root)) need.push(`- **Held handoff** ${h.id}, ${h.from} to ${h.to}: ${h.why}. \`pocketbrain handoff release\` or \`drop\`.`);
  // Proposals.
  // One card per fact: proposals of the same value are one line, answered together.
  for (const { file: f, doc: p, twins } of inboxCards(root) as { file: string; doc: Record<string, any>; twins: { doc: Record<string, any> }[] }[]) {
    const r = p.request ?? {};
    // No source words here: the digest is a file that stays (src/quotes.ts); they're on the card.
    const sc = p.source_check ? ` Source check: **${p.source_check.result}** (${p.source_check.ref}).` : "";
    const also = twins.length ? ` Also said by ${[...new Set(twins.map((t) => String(t.doc.by)))].join(", ")} (${new Set([...(r.sources ?? []), ...twins.flatMap((t) => t.doc.request?.sources ?? [])].map(String)).size} sources).` : "";
    // The digest stays and is backed up: a value is shown as a short slice, the file holds the rest (G92).
    need.push(`- **Proposal** ${f} from ${p.by}: \`${r.id ?? r.title}#${r.attribute ?? ""}\` = ${clip(JSON.stringify(r.value ?? r.text) ?? "", DIGEST_VALUE)} (${clip(String(p.reason ?? ""), DIGEST_REASON)}).${sc}${also} \`inbox --accept\` or \`--reject\`.`);
  }
  // Agent memory corrections (docs/memory-sync.md): proposed ones wait for the owner's word,
  // and an approved one the hub couldn't apply to the file needs his hand.
  // Agent-written text (its answer, its note) quoted on one line, as `memsync list` does (G195).
  const q = (x: string | undefined) => JSON.stringify(oneLine(x ?? ""));
  for (const c of memsyncState(root).corrections) {
    if (c.state === "proposed") need.push(c.kind === "forget"
      ? `- **Memory correction** ${c.id} for ${c.agent} (${oneLine(c.about)}): its memory still has ${q(c.wrong)}, which the brain forgot. \`memsync approve ${c.id}\` or \`memsync decline ${c.id}\`.`
      : `- **Memory correction** ${c.id} for ${c.agent} (${oneLine(c.about)}): its memory says ${q(c.wrong)}, the brain says ${q(c.right)}. \`memsync approve ${c.id}\` or \`memsync decline ${c.id}\`.`);
    else if (c.state === "needs-hand" || c.state === "still-wrong") need.push(`- **Memory fix by hand** ${c.id} for ${c.agent}: ${c.note ? oneLine(c.note) : `still wrong after the hub's edit to ${oneLine(c.from.file ?? "")}:${c.from.line}`}.`);
  }
  // The hub's own checks still failing, every day until they pass (the alert went out once).
  for (const c of failingChecks(root)) need.push(`- **Hub problem** ${c.name}: ${c.detail} (since ${c.since.slice(0, 16).replace("T", " ")})`);
  // What only the owner's hands can do (`pocketbrain task`).
  for (const t of openTasks(root)) need.push(`- **Hand task** ${t.id}: ${t.what} (since ${t.at.slice(0, 10)}).${t.cmd ? ` Run: \`${t.cmd}\`.` : ""} \`pocketbrain task --done ${t.id}\` when it's done.`);
  // Alerts.
  const alerts = jsonl(join(root, "log", "alerts.jsonl")).filter((a) => String(a.at) >= from);
  for (const a of alerts) need.push(`- **Alert** (${a.check}): ${a.agent ?? `${a.from} to ${a.to}`}, ${a.agent && a.from ? a.from : (a.reasons as string[] | undefined)?.[0] ?? ""}`);
  // Escalations from the latest upkeep run.
  const rdir = join(root, "inbox", "reflect");
  const latest = existsSync(rdir) ? readdirSync(rdir).sort().at(-1) : undefined;
  const reflect = latest ? readFileSync(join(rdir, latest), "utf8") : "";
  const section = (title: string) => (reflect.split(`## ${title}`)[1] ?? "").split("\n## ")[0].split("\n").filter((l) => l.startsWith("- "));
  for (const l of [...section("Escalated to the owner"), ...section("Escalated to Louis")].filter((l) => !l.includes("[open-dispute]"))) need.push(l);

  // Rules integrity: rules/ changes only by Louis. Anything else touching it is flagged.
  const dirty = git(root, ["status", "--porcelain", "--", "rules"]).split("\n").filter(Boolean);
  if (dirty.length) need.push(`- **Rules changed outside git**: ${dirty.map((l) => l.slice(3)).join(", ")}. If you didn't do this, \`git checkout rules\`.`);
  const agents = new Set(Object.keys(rules.policy.agents));
  for (const l of git(root, ["log", `--since=${from}`, "--format=%h %an %s", "--", "rules"]).split("\n").filter(Boolean)) {
    const [h, an] = l.split(" ");
    if (agents.has(an)) need.push(`- **Rules commit by ${an}** (${h}): agents never edit rules/. \`git revert ${h}\` unless you asked for it.`);
  }

  // The spend cap (Louis only: the digest is never served to an agent).
  const usage = usageDigest(root, from);
  need.unshift(...usage.need);
  // The weekly memory exam (src/exam.ts): an agent that failed it needs the owner.
  const exam = examLines(root);
  need.push(...exam.need);

  // Last night's sleep pass, on top: a few lines, only if it ran since the last digest.
  const night = morningNote(root);
  const ran = night.file?.match(/sleep-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (ran && `${ran[1]}T${ran[2]}:${ran[3]}:${ran[4]}` >= from.slice(0, 19)) out.push("## Overnight", "", ...night.lines, `- Details: ${night.file}`, "");

  out.push(`## Needs you (${need.length})`, "", ...(need.length ? need : ["Nothing."]), "");

  // Done automatically.
  const auto = git(root, ["log", `--since=${from}`, "--format=%h %s", "-E", "--grep", "^Kind: (auto-fix|resolve|louis-answer|owner-answer)$"]).split("\n").filter(Boolean);
  // Cards the owner left unanswered and the hub decided (docs/decision-deck.md), each undoable in the deck.
  const decided = autoDigestLines(root, from);
  const writes = jsonl(join(root, "log", "writes.jsonl")).filter((w) => String(w.at) >= from);
  const resolved = writes.filter((w) => typeof w.step === "number" && (w.step as number) >= 2 && (w.step as number) <= 5 && w.outcome === "committed" && !w.dispute);
  out.push(`## Done automatically (${auto.length + resolved.length + decided.length})`, "");
  for (const a of auto) out.push(`- ${a}`);
  out.push(...decided);
  for (const w of resolved) out.push(`- ${w.agent}: \`${w.key}\` ${w.step === 4 ? "updated (newer value)" : w.step === 5 ? "replaced by a stronger source" : "merged"} (step ${w.step})`);
  if (!auto.length && !resolved.length && !decided.length) out.push("Nothing.");
  out.push("", "Each is one commit; `git revert <hash>` or `undo --run <id>` takes it back.", "");
  const pulled = pullSummary(root, from);
  const filling = fillLine(root);
  if (pulled || filling) out.push("## Pulled from sources", "", ...[filling, pulled].filter((l): l is string => !!l), "");

  // To review, capped so the digest stays short.
  const review = [...section("To review"), ...section("Model review")];
  // Louis's message ids another agent registered for him: he should recognise each one.
  const regFile = join(root, ownerMessagesPath(root));
  if (existsSync(regFile)) for (const m of ((YAML.parse(readFileSync(regFile, "utf8")) ?? {}).messages ?? []) as { id: string; added: string; note?: string }[])
    if (m.added >= from.slice(0, 10) && /^relayed by /.test(m.note ?? "")) review.unshift(`- [louis-message] \`${m.id}\` ${m.note}: is this your message?`);
  // Standing suggestions from the owner's traffic (docs/standing.md): never applied without him.
  const sug = suggestStanding(root);
  const orphans = orphanStanding(root);
  const broken = standingProblem(root);
  if (broken) review.push(`- [standing] ${broken}: until it is fixed, every sender counts as unknown.`);
  if (orphans.length) review.push(`- [standing] ${orphans.join(", ")}: the note is gone or was replaced, so its standing no longer applies. \`standing set <person> <tier>\` again, or \`none\`.`);
  if (sug.length) review.push(`- [standing] ${sug.length} ${sug.length === 1 ? "person" : "people"} you write to often have no standing yet: \`standing suggest\`, then \`standing approve <person>\`.`);
  out.push(`## Worth a look (${review.length})`, "", ...review.slice(0, 10), ...(review.length > 10 ? [`- …and ${review.length - 10} more in inbox/reflect/${latest}`] : []), "");

  // Numbers.
  const by = (k: string) => { const m = new Map<string, number>(); for (const w of writes) { const v = String(w[k] ?? "?"); m.set(v, (m.get(v) ?? 0) + 1); } return [...m.entries()].map(([a, b]) => `${a} ${b}`).join(", ") || "none"; };
  const refusals = new Map<string, number>();
  for (const w of writes) for (const c of (w.checks as string[] | undefined) ?? []) refusals.set(c, (refusals.get(c) ?? 0) + 1);
  const noop = writes.length ? Math.round((100 * writes.filter((w) => w.outcome === "noop").length) / writes.length) : 0;
  out.push("## Numbers", "",
    scorecardLine(root),
    `- Writes: ${writes.length} (${by("outcome")}); by agent: ${by("agent")}`,
    `- No-op share: ${noop}% (rising is good: agents re-confirm instead of duplicating)`,
    `- Refusals and diversions by check: ${[...refusals.entries()].map(([a, b]) => `${a} ${b}`).join(", ") || "none"}`,
    ...digestLines(root, d),
    ...usage.numbers,
    ...exam.numbers,
    ...shareLines(root),
    ...[auditDigestLine(root), selfCheckLine(root)].filter((l): l is string => !!l),
    `- Views: ${Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall).map(([a]) => `${a} ${carve(notes, rules, grantFor(rules, a)).visible.size}`).join(", ")} notes`,
    "");

  const text = out.join("\n");
  mkdirSync(join(root, "digest"), { recursive: true });
  const file = join(root, "digest", `${d}.md`);
  writeFileSync(file, text);
  return { file, text, needsLouis: need.length };
}
