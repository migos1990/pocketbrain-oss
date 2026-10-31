// SPDX-License-Identifier: AGPL-3.0-only
// Full handover of the brain to another person (portability.md sections 4 and 6).
// Builds a fresh one-commit repo from a stripped and rewritten copy, verifies it, optionally
// encrypts it to the recipient's age key, and records the handover in the source brain.
// It never sends anything: delivery is Louis's step.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { sha256 } from "./util";
import YAML from "yaml";
import { loadBrain, saveNote, slugify, today, linksIn, isList, isDisputed,
  type Note, type Fact, type FactRecord, type SourceRef } from "./brain";
import { git, headCommit } from "./git";
import { refString, schemeOf } from "./sources";
import { OWNER, isOwnerConfirmed } from "./owner";
import { loadRules, ownerName } from "./rules";

// The previous owner's display name (policy.yaml owner.name), set at the start of each handover.
let PREV = "the previous owner";

export interface HandoverOptions {
  to: string; // recipient's name, as it should appear in HANDOVER.md
  out: string; // output folder for the new repo; must not exist
  ageKey?: string; // recipient's age public key (age1...); without it the package stays unencrypted
  includeAgents?: boolean; // keep agents/ capability notes (Louis's assistants); default off
  includeSecret?: boolean; // keep `secret` notes and facts; default off (they're never handed over in clear)
  allowDirty?: boolean; // skip the clean-worktree check (tests, dry runs)
  record?: boolean; // write handovers/<date>-<recipient>.md in the source brain; default on
}

export interface HandoverResult {
  out: string;
  package?: string;
  sourceCommit: string;
  kept: number;
  stripped: { path: string; reason: string }[];
  rewrites: Record<string, number>;
  openDisputes: string[];
  problems: string[]; // verification hits; non-empty means the handover failed and out/ was removed
}

// Source schemes that point into the previous owner's private accounts or agents.
// Exact ones keep their weight as `prior:<kind>`; vague ones become `prior-note:<kind>`.
const PRIVATE_REFS: Record<string, string> = {
  gmail: "prior:email",
  "gmail-thread": "prior:email",
  gcal: "prior:calendar",
  doc: "prior:document",
  call: "prior:call",
  imsg: "prior:owner-message",
  louis: "prior:owner-message",
  notion: "prior-note:notion",
  "notion-cli": "prior-note:notion",
  "town-wiki": "prior-note:agent",
  "instinct-mem": "prior-note:agent",
  "town-routine": "prior-note:agent",
  "agent-relay": "prior-note:agent",
  agent: "prior-note:agent",
  mailto: "prior:email-address",
};

// Raw ids that must never appear in the package (verify step), and that get scrubbed from prose.
const ID_PATTERNS: [RegExp, string][] = [
  [/phonemsg-[0-9A-Z]{20,30}/g, "[private message ref]"],
  [/\bm1\.[A-Za-z0-9+/=_-]{16,}/g, "[private email ref]"],
  [/\bevt1\.[A-Za-z0-9_-]+/g, "[private calendar ref]"],
  [/\b(?:gmail|gmail-thread|gcal|imsg|instinct-mem|town-wiki|town-routine|agent-relay):[^\s,;)\]]+/g, "[private ref]"],
  [/(?<![0-9a-zA-Z-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{16}(?![0-9a-zA-Z])/g, "[private ref]"],
];

// Only these leave the source brain. Everything else (inbox, comms, digest, views, log,
// import, archive, relay, journal, tokens, instructions) is Louis's working state.
const RULES_KEPT = ["RULES.md", "checks.yaml", "slices.yaml", "suppressions.yaml"];

function count(m: Record<string, number>, k: string, n = 1) { m[k] = (m[k] ?? 0) + n; }

function canaries(root: string): string[] {
  const out: string[] = [];
  for (const f of ["relay.yaml", "canaries.yaml"]) {
    const p = join(root, "rules", f);
    if (!existsSync(p)) continue;
    const doc = YAML.parse(readFileSync(p, "utf8")) ?? {};
    for (const c of doc.canaries ?? []) if (typeof c === "string" && c.trim()) out.push(c.trim());
  }
  return out;
}

function isCanary(n: Note, marks: string[]): boolean {
  if ((n.fm.tags ?? []).includes("canary")) return true;
  const text = (n.fm.title + "\n" + n.body).toLowerCase();
  return marks.some((c) => text.includes(c.toLowerCase()));
}

function scrubText(s: string, rw: Record<string, number>): string {
  let out = s;
  for (const [re, rep] of ID_PATTERNS) out = out.replace(re, () => { count(rw, "private ids scrubbed from text"); return rep; });
  return out;
}

function rewriteRef(r: SourceRef, rw: Record<string, number>): SourceRef {
  const ref = refString(r);
  const scheme = schemeOf(ref) ?? ref.match(/^([a-z][a-z-]*):/)?.[1];
  let to = scheme ? PRIVATE_REFS[scheme] : undefined;
  // Any other ref that still carries a private id (an import artifact like url:http://evt1.bg/).
  if (!to && ID_PATTERNS.some(([re]) => new RegExp(re.source).test(ref))) to = "prior:reference";
  if (!to) return r;
  count(rw, "source refs replaced by type");
  return to;
}

function rewriteRecord(r: FactRecord, rw: Record<string, number>): FactRecord | undefined {
  const out: FactRecord & Record<string, unknown> = { ...r };
  out.sources = [...new Set((r.sources ?? []).map((s) => rewriteRef(s, rw)).map((s) => JSON.stringify(s)))].map((s) => JSON.parse(s));
  if (isOwnerConfirmed(r.verification)) {
    // Still the strongest source in the brain's history, but one the new owner can overrule:
    // their own statements rank above it (portability.md 4.4).
    out.verification = "verified-by-source";
    out.confirmed_by = `previous owner (${PREV}), as of ${r.last_confirmed ?? r.as_of}`;
    count(rw, "confirmed-by-louis -> confirmed by previous owner");
  }
  if (r.share_with) { delete out.share_with; count(rw, "agent-only share_with removed"); }
  if (typeof r.value === "string") out.value = scrubText(r.value, rw);
  if (r.note) out.note = scrubText(r.note, rw);
  return out;
}

function rewriteFact(f: Fact, rw: Record<string, number>, keepSecret: boolean): Fact | undefined {
  const keep = (r: FactRecord) => keepSecret || r.sensitivity !== "secret";
  if (isList(f)) {
    const items = f.items.filter(keep).map((r) => rewriteRecord(r, rw)!);
    if (items.length < f.items.length) count(rw, "secret facts dropped", f.items.length - items.length);
    return items.length ? { items } : undefined;
  }
  if (isDisputed(f)) return { dispute: f.dispute, candidates: f.candidates.filter(keep).map((r) => rewriteRecord(r, rw)!) };
  if (!keep(f as FactRecord)) { count(rw, "secret facts dropped"); return undefined; }
  return rewriteRecord(f as FactRecord, rw);
}

function rewriteNote(n: Note, keepIds: Set<string>, rw: Record<string, number>, keepSecret: boolean): Note {
  const fm = structuredClone(n.fm);
  if (fm.legacy) { delete fm.legacy; count(rw, "Notion legacy ids removed"); }
  if (isOwnerConfirmed(fm.verification)) {
    fm.verification = "verified-by-source";
    fm.confirmed_by = `previous owner (${PREV})`;
    count(rw, "confirmed-by-louis -> confirmed by previous owner");
  }
  if (fm.sources) fm.sources = [...new Set(fm.sources.map((s) => JSON.stringify(rewriteRef(s, rw))))].map((s) => JSON.parse(s));
  if (fm.facts) {
    for (const [k, f] of Object.entries(fm.facts)) {
      const nf = rewriteFact(f, rw, keepSecret);
      if (nf) fm.facts[k] = nf; else delete fm.facts[k];
    }
  }
  if (fm.history) {
    for (const [k, rs] of Object.entries(fm.history)) {
      fm.history[k] = rs.filter((r) => keepSecret || r.sensitivity !== "secret").map((r) => rewriteRecord(r, rw)!);
    }
  }
  let body = scrubText(n.body, rw);
  for (const l of new Set(linksIn(body))) {
    if (!keepIds.has(l)) {
      body = body.split(`[[${l}`).join("[[redacted");
      count(rw, "links to stripped notes redacted");
    }
  }
  return { fm, body, path: n.path };
}

function rewriteRules(text: string): string {
  const esc = PREV.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `> Handed over from ${PREV}'s pocketBrain. "${PREV}" below means the owner of this brain, now you.\n\n` +
    text.replace(new RegExp(`${esc}'s`, "g"), "the owner's").replace(new RegExp(`\\b${esc}\\b`, "g"), "the owner");
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

// Search every file in the package for anything that must not leave (portability.md 6, step 7).
export function verifyPackage(out: string, marks: string[], keepSecret: boolean): string[] {
  const problems: string[] = [];
  for (const rel of walkFiles(out)) {
    if (rel === "HANDOVER.md") continue; // describes what was stripped, by count only
    const text = readFileSync(join(out, rel), "utf8");
    for (const [re] of ID_PATTERNS) {
      const m = text.match(new RegExp(re.source, "g"));
      if (m) problems.push(`${rel}: private id ${m[0]}`);
    }
    for (const c of marks) if (text.toLowerCase().includes(c.toLowerCase())) problems.push(`${rel}: canary "${c}"`);
    if (/confirmed-by-(louis|owner)/.test(text)) problems.push(`${rel}: unrewritten confirmed-by-louis`);
    if (!keepSecret && /^sensitivity: secret$/m.test(text)) problems.push(`${rel}: secret note`);
    if (rel !== "manifest.json" && /token_hash|sha256:[0-9a-f]{64}/.test(text)) problems.push(`${rel}: credential-shaped string`);
  }
  try { loadBrain(out); } catch (e) { problems.push(`package does not load: ${(e as Error).message}`); }
  return problems;
}

export function handover(root: string, o: HandoverOptions): HandoverResult {
  PREV = ownerName(loadRules(root));
  if (existsSync(o.out)) throw new Error(`${o.out} already exists; handover never overwrites`);
  if (!o.allowDirty && existsSync(join(root, ".git"))) {
    const dirty = git(root, ["status", "--porcelain"]);
    if (dirty) throw new Error(`the brain has uncommitted changes; commit them first:\n${dirty}`);
  }
  const sourceCommit = headCommit(root);
  const marks = canaries(root);
  const notes = loadBrain(root);
  const stripped: HandoverResult["stripped"] = [];
  const rw: Record<string, number> = {};

  // 2-3. Select and strip.
  const kept: Note[] = [];
  for (const n of notes) {
    if (isCanary(n, marks)) { stripped.push({ path: n.path, reason: "canary note" }); continue; }
    if (!o.includeAgents && n.fm.id.startsWith("agents/")) { stripped.push({ path: n.path, reason: `agent capability note (${PREV}'s assistants)` }); continue; }
    if (!o.includeSecret && n.fm.sensitivity === "secret") { stripped.push({ path: n.path, reason: "secret note" }); continue; }
    kept.push(n);
  }
  const keepIds = new Set(kept.map((n) => n.fm.id));

  // 4. Rewrite, into the new folder.
  mkdirSync(o.out, { recursive: true });
  try {
    for (const n of kept) saveNote(o.out, rewriteNote(n, keepIds, rw, !!o.includeSecret));
    mkdirSync(join(o.out, "rules"), { recursive: true });
    for (const f of RULES_KEPT) {
      const p = join(root, "rules", f);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      writeFileSync(join(o.out, "rules", f), f === "RULES.md" ? scrubText(rewriteRules(text), rw) : scrubText(text, rw));
    }
    // A blank policy: no agents, no resolver, every area owned by the new owner.
    const areas = Object.fromEntries([...new Set(kept.map((n) => n.fm.area))].sort().map((a) => [a, { owner: "owner" }]));
    writeFileSync(join(o.out, "rules", "policy.yaml"), YAML.stringify({
      agents: {},
      tiers: { core: { max_sensitivity: "private", writes: "direct" }, trial: { max_sensitivity: "personal", writes: "propose" } },
      areas,
    }));
    writeFileSync(join(o.out, ".gitignore"), "views/\nlog/\n");

    const openDisputes = kept.filter((n) => Object.values(n.fm.facts ?? {}).some(isDisputed)).map((n) => n.fm.id);

    // 6. HANDOVER.md and manifest.json.
    const byDir: Record<string, number> = {};
    for (const n of kept) count(byDir, n.fm.id.split("/")[0]);
    writeFileSync(join(o.out, "HANDOVER.md"), handoverDoc(o, sourceCommit, byDir, stripped, rw, openDisputes));
    const files = walkFiles(o.out).filter((f) => f !== "manifest.json");
    writeFileSync(join(o.out, "manifest.json"), JSON.stringify({
      format: "pocketbrain/1",
      handed_over: today(),
      to: o.to,
      source_commit: sourceCommit,
      notes: kept.length,
      by_folder: byDir,
      stripped: stripped.length,
      open_disputes: openDisputes.length,
      files: Object.fromEntries(files.map((f) => [f, "sha256:" + sha256(readFileSync(join(o.out, f)))])),
    }, null, 2) + "\n");

    // 7. Verify before anything gets committed or encrypted.
    const problems = verifyPackage(o.out, marks, !!o.includeSecret);
    if (problems.length) {
      rmSync(o.out, { recursive: true, force: true });
      return { out: o.out, sourceCommit, kept: kept.length, stripped, rewrites: rw, openDisputes, problems };
    }

    // 5. Fresh repository: one commit, so nothing stripped is recoverable from history.
    const env = { ...process.env, GIT_AUTHOR_NAME: "handover", GIT_AUTHOR_EMAIL: "handover@pocketbrain.local", GIT_COMMITTER_NAME: "handover", GIT_COMMITTER_EMAIL: "handover@pocketbrain.local" };
    const run = (args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: o.out, env });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    run(["init", "-q", "-b", "main"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", `Brain handed over to ${o.to} on ${today()} (from source commit ${sourceCommit})`]);

    // 8. Encrypt and stop.
    let pkg: string | undefined;
    if (o.ageKey) {
      pkg = join(dirname(o.out), `handover-${slugify(o.to)}-${today()}.tar.age`);
      const tar = Bun.spawnSync(["tar", "-czf", "-", "-C", dirname(o.out), relative(dirname(o.out), o.out)]);
      if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr.toString()}`);
      const age = Bun.spawnSync(["age", "-r", o.ageKey, "-o", pkg], { stdin: tar.stdout });
      if (age.exitCode !== 0) throw new Error(`age: ${age.stderr.toString()}`);
    }

    // 9. Record who got what, in Louis's own brain.
    if (o.record !== false) {
      const rec = join(root, "handovers", `${today()}-${slugify(o.to)}.md`);
      mkdirSync(dirname(rec), { recursive: true });
      const pkgHash = pkg ? sha256(readFileSync(pkg)) : "(unencrypted folder)";
      writeFileSync(rec, `# Handover to ${o.to}, ${today()}\n\n- Scope: full\n- Source commit: ${sourceCommit}\n- Notes handed over: ${kept.length}\n- Stripped: ${stripped.length} notes (${summarize(stripped)})\n- Package: ${pkg ? relative(root, pkg).startsWith("..") ? pkg : relative(root, pkg) : o.out}\n- Package sha256: ${pkgHash}\n- Encrypted to: ${o.ageKey ?? "not encrypted"}\n`);
      git(root, ["add", relative(root, rec)], OWNER);
      git(root, ["commit", "-q", "-m", `handover: record package for ${o.to}`], OWNER);
    }
    return { out: o.out, package: pkg, sourceCommit, kept: kept.length, stripped, rewrites: rw, openDisputes, problems: [] };
  } catch (e) {
    rmSync(o.out, { recursive: true, force: true });
    throw e;
  }
}

function summarize(stripped: HandoverResult["stripped"]): string {
  const by: Record<string, number> = {};
  for (const s of stripped) count(by, s.reason);
  return Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
}

function handoverDoc(o: HandoverOptions, sourceCommit: string, byDir: Record<string, number>,
  stripped: HandoverResult["stripped"], rw: Record<string, number>, openDisputes: string[]): string {
  const total = Object.values(byDir).reduce((a, b) => a + b, 0);
  return `# This brain was handed over to ${o.to}

Handed over on ${today()} from ${PREV}'s pocketBrain (source commit \`${sourceCommit}\`). It is now yours: you are its owner, and the rules in \`rules/RULES.md\` now say "the owner" where they said ${PREV}.

## How to read it without any software

Every file is plain Markdown. Open the folders in any editor, or in Obsidian. Each file is one thing (a person, a project, a decision, a note). The block between the \`---\` lines at the top holds its facts: each fact has a value, the date it was true as of (\`as_of\`), where it came from (\`sources\`) and how sure it is (\`verification\`). \`[[folder/name]]\` is a link to another file. \`history:\` keeps older values, so nothing was deleted.

## What's here

${total} notes: ${Object.entries(byDir).map(([k, v]) => `${v} ${k}`).join(", ")}.

## What was taken out, and why

- **${stripped.length} notes**: ${summarize(stripped)}. Canary notes were fake on purpose (they detect misuse) and agent notes describe ${PREV}'s own assistants.
- **${PREV}'s working state**: their agents and their access, their messages to each other, pending proposals, the read log, and pasted views. None of it is knowledge about the world.
- **Private ids** (${(rw["source refs replaced by type"] ?? 0) + (rw["private ids scrubbed from text"] ?? 0)} places): references into ${PREV}'s own email, calendar and messages were replaced by their kind (\`prior:email\`, \`prior:owner-message\`, \`prior-note:agent\`). You couldn't open them, and they'd leak his accounts.
- **Notion ids** from the original import were removed.${o.includeSecret ? "" : "\n- **Secret notes and facts** were left out. They are never handed over in clear."}

## What changed meaning

- Facts ${PREV} had confirmed themselves now read \`verification: verified-by-source\` with \`confirmed_by: previous owner (${PREV})\` (${rw["confirmed-by-louis -> confirmed by previous owner"] ?? 0} facts). They're still the best-sourced facts here, but your own word now outranks them.
- \`by:\` fields still name the assistant that wrote each fact (instinct, town, muse, claude). They're history, not access.

## Open questions you inherit

${openDisputes.length ? `${openDisputes.length} notes have a disputed fact (two values, neither confirmed): ${openDisputes.map((d) => `\`${d}\``).join(", ")}.` : "No disputed facts."}

## Known limits

- Facts are only as fresh as their \`as_of\` dates. Anything with a shelf life (roles, balances, next steps) should be rechecked before you rely on it.
- Cite your own word as \`owner:<date>/<topic>\` (a fact you tell an agent yourself).
`;
}
