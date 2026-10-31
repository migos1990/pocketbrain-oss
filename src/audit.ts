// SPDX-License-Identifier: AGPL-3.0-only
// The weekly carve audit (`pocketbrain audit carve`, Sundays in `start`): did any agent's reach
// grow since the last audit without the owner doing it? Each agent's grant (slices, ceiling,
// tier, excludes, kill switch, editor, resolver) and the notes and facts its carve shows are
// compared with the last snapshot in log/carve-audit.jsonl (or, the first time, the brain as
// committed a week ago). Every widening is traced to the commits on the paths that caused it:
// rules/ when the old rules would not have shown it, the note's own file otherwise. A widening
// is fine only when every one of those commits is the owner's and nothing is uncommitted;
// anything else is one `carve_widened` alert per agent (Needs-you). Deterministic, no model.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrain, sensitivityRank, type Note, type Sensitivity } from "./brain";
import { loadRules, tierOf, type Rules } from "./rules";
import { carve, grantFor, visibleFacts, type CarveResult } from "./carve";
import { git, gitTime } from "./git";
import { isOwnerId } from "./owner";
import { alert, appendJsonl, readJsonl } from "./util";

interface AgentState {
  tier: string; ceiling: Sensitivity; slices: string[]; exclude_types: string[]; exclude: string[];
  inside_wall: boolean; status: string; editor: boolean; resolver: boolean; notes: string[]; facts: string[];
}
export interface CarveSnapshot { at: string; commit: string; ids: string[]; facts: string[]; agents: Record<string, AgentState> }
export interface Cause { commit: string; author: string; subject: string }
export interface Widening { agent: string; what: string; paths: string[]; causes: Cause[]; uncommitted: string[]; ok: boolean }
export interface AuditResult { baseline: "snapshot" | "git" | "none"; since?: string; widenings: Widening[]; alerts: number; text: string }

const FILE = (root: string) => join(root, "log", "carve-audit.jsonl");
const STATUS_RANK: Record<string, number> = { paused: 0, "read-only": 1, active: 2 };
const factKeys = (res: CarveResult) => [...res.visible.values()].flatMap((v) => visibleFacts(v, res).map(([a]) => `${v.note.fm.id}#${a}`));

function safeCarve(notes: Note[], rules: Rules, agent: string): CarveResult | undefined {
  try { return carve(notes, rules, grantFor(rules, agent)); } catch { return undefined; }
}

export function carveSnapshot(dir: string, commit = "uncommitted"): CarveSnapshot {
  const rules = loadRules(dir);
  const notes = loadBrain(dir);
  const agents: Record<string, AgentState> = {};
  for (const [name, a] of Object.entries(rules.policy.agents ?? {})) {
    const res = a.inside_wall ? undefined : safeCarve(notes, rules, name);
    agents[name] = {
      tier: a.tier, ceiling: a.max_sensitivity ?? tierOf(rules, name).max_sensitivity, slices: [...(a.slices ?? [])].sort(),
      exclude_types: a.exclude_types ?? [], exclude: a.exclude ?? [], inside_wall: !!a.inside_wall, status: a.status ?? "active",
      editor: rules.policy.owner_editor === name, resolver: rules.policy.resolver === name,
      notes: res ? [...res.visible.keys()].sort() : [], facts: res ? factKeys(res).sort() : [],
    };
  }
  return { at: new Date().toISOString(), commit, ids: notes.map((n) => n.fm.id).sort(), facts: notes.flatMap((n) => Object.keys(n.fm.facts ?? {}).map((k) => `${n.fm.id}#${k}`)).sort(), agents };
}

// The tree of one commit (or only some of its paths) in a temp folder.
function materialize(root: string, sha: string, paths: string[] = []): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "pb-audit-"));
  const tar = join(dir, ".a.tar");
  const a = Bun.spawnSync(["git", "archive", "--format=tar", "-o", tar, sha, ...paths], { cwd: root });
  if (a.exitCode !== 0 || !Bun.spawnSync(["tar", "-xf", tar, "-C", dir]).success) { rmSync(dir, { recursive: true, force: true }); return undefined; }
  rmSync(tar, { force: true });
  return dir;
}

const head = (root: string) => git(root, ["rev-parse", "HEAD"]);
const known = (root: string, sha: string) => !!sha && Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: root }).exitCode === 0;

function baselineFor(root: string, now: Date): { snap: CarveSnapshot; from: AuditResult["baseline"] } | undefined {
  const last = readJsonl<CarveSnapshot>(FILE(root)).at(-1);
  if (last?.agents) return { snap: last, from: "snapshot" };
  if (!head(root)) return undefined;
  const sha = git(root, ["rev-list", "-1", `--before=${new Date(now.getTime() - 7 * 86_400_000).toISOString()}`, "HEAD"]) || git(root, ["rev-list", "--max-parents=0", "HEAD"]).split("\n").at(-1)!;
  const dir = materialize(root, sha);
  if (!dir) return undefined;
  try { return { snap: { ...carveSnapshot(dir, sha), at: gitTime(git(root, ["log", "-1", "--format=%cI", sha])) }, from: "git" }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function grantWidenings(agent: string, was: AgentState | undefined, now: AgentState): string[] {
  if (!was) return ["new agent"];
  const out: string[] = [];
  for (const s of now.slices) if (!was.slices.includes(s)) out.push(`slices +${s}`);
  if (was.tier === "trial" && now.tier !== "trial") out.push(`tier ${was.tier} -> ${now.tier}`);
  if (sensitivityRank(now.ceiling) > sensitivityRank(was.ceiling)) out.push(`max_sensitivity ${was.ceiling} -> ${now.ceiling}`);
  for (const t of was.exclude_types) if (!now.exclude_types.includes(t)) out.push(`exclude_types -${t}`);
  for (const t of was.exclude) if (!now.exclude.includes(t)) out.push(`exclude -${t}`);
  if (now.inside_wall && !was.inside_wall) out.push("inside_wall on");
  if ((STATUS_RANK[now.status] ?? 2) > (STATUS_RANK[was.status] ?? 2)) out.push(`status ${was.status} -> ${now.status}`);
  if (now.editor && !was.editor) out.push("made the owner's editor");
  if (now.resolver && !was.resolver) out.push("made the resolver");
  void agent;
  return out;
}

export function auditCarve(root: string, opts: { now?: Date; save?: boolean; alert?: boolean } = {}): AuditResult {
  const now = opts.now ?? new Date();
  const base = baselineFor(root, now);
  const cur = carveSnapshot(root, head(root) || "uncommitted");
  const rules = loadRules(root);
  const ownerDisplay = rules.policy.owner?.name;
  // The owner's hand commits (a terminal on their machine) carry the brain repo's git user.name,
  // often a handle rather than "owner" (G376). The hub always commits under an explicit name, so
  // that name is the owner's too, unless it is an agent's.
  const hand = git(root, ["config", "user.name"]).trim();
  const byOwner = (author: string) => isOwnerId(author, ownerDisplay) || (!!hand && author === hand && !rules.policy.agents[hand]);
  const widenings: Widening[] = [];
  if (base) {
    const b = base.snap;
    const ids = new Set(b.ids), facts = new Set(b.facts);
    // The rules as they were, applied to today's notes, tell a rule change from a note change.
    const rulesDir = known(root, b.commit) ? materialize(root, b.commit, ["rules"]) : undefined;
    const baseRules = rulesDir ? (() => { try { return loadRules(rulesDir); } catch { return undefined; } })() : undefined;
    if (rulesDir) rmSync(rulesDir, { recursive: true, force: true });
    const notes = loadBrain(root);
    const range = known(root, b.commit) ? [`${b.commit}..HEAD`] : [`--since=${b.at}`];
    const causes = (paths: string[]): Cause[] => git(root, ["log", "--format=%h%x09%an%x09%s", ...range, "--", ...paths]).split("\n").filter(Boolean)
      .map((l) => { const [commit, author, ...s] = l.split("\t"); return { commit, author, subject: s.join("\t") }; });
    const dirty = (paths: string[]) => git(root, ["status", "--porcelain", "--", ...paths]).split("\n").filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, ""));
    const judge = (agent: string, what: string, paths: string[]) => {
      const c = causes(paths), u = dirty(paths);
      widenings.push({ agent, what, paths, causes: c, uncommitted: u, ok: c.length > 0 && !u.length && c.every((x) => byOwner(x.author)) });
    };
    for (const [agent, st] of Object.entries(cur.agents)) {
      const was = b.agents[agent];
      for (const w of grantWidenings(agent, was, st)) judge(agent, w, ["rules"]);
      if (!was) continue;
      const old = baseRules?.policy.agents[agent] && !baseRules.policy.agents[agent].inside_wall ? safeCarve(notes, baseRules, agent) : undefined;
      const oldFacts = old ? new Set(factKeys(old)) : undefined;
      const seen = new Set(was.notes), seenFacts = new Set(was.facts);
      for (const id of st.notes) if (!seen.has(id) && ids.has(id))
        judge(agent, `note ${id} now visible`, !baseRules ? ["rules", `${id}.md`] : old?.visible.has(id) ? [`${id}.md`] : ["rules"]);
      for (const k of st.facts) {
        const id = k.split("#")[0];
        if (seenFacts.has(k) || !facts.has(k) || !seen.has(id)) continue;
        judge(agent, `fact ${k} now visible`, !baseRules ? ["rules", `${id}.md`] : oldFacts?.has(k) ? [`${id}.md`] : ["rules"]);
      }
    }
  }
  const bad = widenings.filter((w) => !w.ok);
  const byAgent = new Map<string, Widening[]>();
  for (const w of bad) byAgent.set(w.agent, [...(byAgent.get(w.agent) ?? []), w]);
  const why = (w: Widening) => `${w.what} (${[...w.causes.map((c) => `${c.commit} by ${c.author}`), ...w.uncommitted.map((p) => `${p} uncommitted`)].join(", ") || "no commit explains it"})`;
  if (opts.alert !== false) for (const [agent, ws] of byAgent)
    alert(root, { agent, check: "carve_widened", from: `${ws.slice(0, 3).map(why).join("; ")}${ws.length > 3 ? `; and ${ws.length - 3} more` : ""}. \`pocketbrain audit carve\` lists them` });
  if (opts.save !== false) appendJsonl(FILE(root), { ...cur, widenings: widenings.length, alerts: byAgent.size, not_owner: bad.length });
  const text = [
    base ? `Carve audit since ${base.snap.at.slice(0, 16)} (${base.from === "snapshot" ? "last audit" : `commit ${base.snap.commit.slice(0, 7)}`}): ${widenings.length} widening(s), ${bad.length} not by the owner.` : "Carve audit: first run, baseline recorded.",
    ...widenings.map((w) => `${w.ok ? "  ok   " : "  ALERT"} ${w.agent}: ${why(w)}`),
  ].join("\n");
  return { baseline: base?.from ?? "none", since: base?.snap.at, widenings, alerts: byAgent.size, text };
}

// The digest's line: the last audit within the week, if any.
export function auditDigestLine(root: string, now = new Date()): string | undefined {
  const last = existsSync(FILE(root)) ? readJsonl<{ at: string; widenings?: number; not_owner?: number }>(FILE(root)).at(-1) : undefined;
  if (!last || now.getTime() - Date.parse(last.at) > 8 * 86_400_000) return undefined;
  return `- Carve audit ${last.at.slice(0, 10)}: ${last.widenings ?? 0} widening(s), ${last.not_owner ?? 0} not by you`;
}
