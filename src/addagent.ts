// SPDX-License-Identifier: AGPL-3.0-only
// A new agent in one step (docs/add-an-agent.md): `pocketbrain add` and the dashboard's
// "New agent" card for a waiting sign-in both come here. A new agent is always trial (its writes
// wait for the owner), never gets the all slice, and money is left out unless the owner says so.
// The preview is the same carve the server will apply, so what the owner approves is what it sees.
// `add <new> --like <old>` (switch day, docs/switch-day.md) starts from another agent's carve via
// likeAgent: only what narrows carries over.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules, RESERVED_AGENTS, type Rules } from "./rules";
import { loadBrain, sensitivityRank, type Sensitivity } from "./brain";
import { carve, grantFor, renderPreview } from "./carve";
import { buildView } from "./view";
import { git } from "./git";
import { OWNER, isOwnerId } from "./owner";

export interface NewAgent {
  agent: string; slices: string[]; exclude_types?: string[]; name?: string; transport?: "mcp" | "api";
  exclude?: string[]; max_sensitivity?: Sensitivity; // only ever narrower than trial's ceiling
  // Narrowing settings a switch-day copy keeps from the agent it replaces (likeAgent).
  status?: "read-only"; windows?: string[]; max_proposals_per_day?: number;
}
export interface NewAgentPreview {
  agent: string; notes: number; total: number; areas: string[]; kinds: Record<string, number>;
  money: boolean; private: boolean; ceiling: string; text: string; sample: string[];
}

export const AGENT_NAME = /^[a-z][a-z0-9-]{1,30}$/;
// Names a new agent never takes: the hub's own roles, and the all slice.
export const RESERVED = new Set(["hub", "relay", "gardener", "all"]);

// Folds a shown name the way a phone push or a quick glance does: accents, case, spaces and
// punctuation don't count ("Stéward", "STEWARD" and "ste-ward" are one name).
// Cyrillic and Greek letters that look Latin are mapped first, so "Lоuis" with a Cyrillic о is "louis".
const CONFUSABLE: Record<string, string> = { "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ӏ": "l", "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "г": "r", "ı": "i", "ɪ": "i", "ɡ": "g", "ʟ": "l", "ʀ": "r", "һ": "h", "ԛ": "q", "ԝ": "w", "ѵ": "v", "ɩ": "i", "ո": "n", "ս": "u", "օ": "o" };
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/./gu, (c) => CONFUSABLE[c] ?? c).replace(/[^a-z0-9]/g, "");
// What a name looks like at a glance: digits read as the letters they mimic, letter pairs that
// read as one letter (cl as d, rn as m, vv as w) and l as i, so "p1anner", "P1ann3r" and
// "pianner" are all "planner" (G160) and "stewarcl" is "steward" (G167).
const DIGIT: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };
const PAIRS: [RegExp, string][] = [[/cl/g, "d"], [/rn/g, "m"], [/vv/g, "w"]];
const skel = (s: string) => PAIRS.reduce((x, [re, to]) => x.replace(re, to), fold(s).replace(/[0-9]/g, (d) => DIGIT[d] ?? d)).replace(/l/g, "i");
// The hub's own roles: a name holding one ("gardener-bot", "pocketbrain-admin") reads as it.
const ROLES = ["gardener", "relay", "pocketbrain"];

// Whom a shown name would pass for: "owner" when it reads as the owner, else the agent whose id,
// label or alias it matches. A new agent's label never may (an approval push or the dashboard
// would show it as them).
export function lookalike(rules: Rules, name: string): string | undefined {
  const n = skel(name);
  if (!n) return undefined;
  // A label that holds the owner's name or the word owner anywhere ("Louis (owner)", "Louis M.") reads as the owner too.
  if ([OWNER, "louis", ...(rules.policy.owner?.name ?? "").split(/\s+/)].some((x) => x && skel(x).length >= 3 && n.includes(skel(x)))) return OWNER;
  for (const [key, a] of Object.entries(rules.policy.agents)) {
    if ([key, a.label ?? "", ...(a.aliases ?? [])].some((x) => x && skel(x) === n)) return key;
  }
  if (n === "hub") return n;
  return ROLES.find((r) => n.includes(skel(r)));
}

// A new agent is trial, and trial's ceiling is personal; nothing about adding one may raise it.
const TRIAL_CEILING: Sensitivity = "personal";

// lookalike, also trying the name without a trailing number or version ("helper2", "helper_v2",
// "helper-3" read as helper): for spotting an agent coming back, not for refusing labels (G177).
export function lookalikeBase(rules: Rules, name: string): string | undefined {
  const bare = name.replace(/[\s\-_.]*v?\d+$/i, "");
  return lookalike(rules, name) ?? (bare && bare !== name ? lookalike(rules, bare) : undefined);
}

// Throws with a sentence the owner can act on; nothing is written.
export function checkNewAgent(rules: Rules, a: NewAgent): void {
  if (!AGENT_NAME.test(a.agent)) throw new Error("the agent name is 2 to 31 lowercase letters, digits and dashes, starting with a letter");
  // An agent named like the owner would have its commits and widenings read as the owner's.
  if (isOwnerId(a.agent, rules.policy.owner?.name)) throw new Error(`${a.agent} is reserved for the owner; pick another name`);
  if (RESERVED.has(a.agent)) throw new Error(`${a.agent} is reserved; pick another name`);
  const like = a.name ? lookalike(rules, a.name) : undefined;
  if (like) throw new Error(`the label "${a.name}" reads as ${like === OWNER ? "you" : like}; leave it empty or pick another`);
  if (RESERVED_AGENTS.includes(a.agent)) throw new Error(`${a.agent} is the hub's own name; pick another`);
  if (rules.policy.agents[a.agent]) throw new Error(`${a.agent} is already in policy.yaml; change its slice with carve, give it a token with connect, or reopen sign-in approval with oauth expect`);
  if (!a.slices.length) throw new Error("pick at least one slice (for example area:work and contacts-basic)");
  if (a.slices.includes("all")) throw new Error("a new agent starts as trial with a slice; the all slice is a choice to make in policy.yaml yourself");
  const unknown = a.slices.filter((s) => !rules.slices[s]);
  if (unknown.length) throw new Error(`unknown slice(s): ${unknown.join(", ")} (see rules/slices.yaml)`);
  if (a.max_sensitivity && sensitivityRank(a.max_sensitivity) > sensitivityRank(TRIAL_CEILING)) throw new Error(`a new agent sees up to ${TRIAL_CEILING} at most; raise it in policy.yaml yourself once it has earned it`);
}

// carve gives an agent every note of the area it is named after (src/carve.ts, "own"), so a new
// agent named after an area would see that whole area whatever slice the owner picked.
export function checkNotAnArea(rules: Rules, notes: { fm: { area?: string } }[], agent: string) {
  if (rules.policy.areas?.[agent] || notes.some((n) => n.fm.area === agent)) throw new Error(`${agent} is the name of an area, and an agent named after an area sees all of it; pick another name`);
}

// Switch day: the carve of the agent being replaced, as a new trial agent's starting point. Only
// what narrows carries over: slices, leave-outs, its effective ceiling when below trial's (its own
// or its tier's), read-only, its hours and its proposal cap. Tier, area ownership, the browser door
// and a pause stay behind (the old one is paused because it is being replaced). Throws for agents
// whose access isn't a carve to copy.
export function likeAgent(rules: Rules, from: string): Pick<NewAgent, "slices" | "exclude_types" | "exclude" | "max_sensitivity" | "transport" | "status" | "windows" | "max_proposals_per_day"> {
  const a = rules.policy.agents[from];
  if (!a) throw new Error(`no agent ${from} in policy.yaml to copy from`);
  if (a.inside_wall) throw new Error(`${from} is inside the wall; a new agent starts from an outside agent's slice`);
  if (a.role === "gardener") throw new Error(`${from} is the gardener; its reach is for keeping the brain, not for an assistant`);
  if (a.collaborator) throw new Error(`${from} is a share with a person (pocketbrain share), not an assistant to switch from`);
  const slices = a.slices ?? [];
  if (slices.includes("all")) throw new Error(`${from} has the all slice, which a new agent never gets; name its slices with --slices instead of --like`);
  // What it actually sees up to: its own max_sensitivity, else its tier's.
  const ceiling = grantFor(rules, from).ceiling;
  return {
    slices: [...slices],
    exclude_types: [...new Set([...(a.exclude_types ?? []), "money"])],
    ...(a.exclude?.length ? { exclude: [...a.exclude] } : {}),
    ...(sensitivityRank(ceiling) < sensitivityRank(TRIAL_CEILING) ? { max_sensitivity: ceiling } : {}),
    transport: a.transport === "api" ? "api" : "mcp",
    ...(a.status === "read-only" ? { status: "read-only" as const } : {}),
    ...(a.windows?.length ? { windows: [...a.windows] } : {}),
    ...(a.max_proposals_per_day !== undefined ? { max_proposals_per_day: a.max_proposals_per_day } : {}),
  };
}


export function previewNewAgent(root: string, a: NewAgent): NewAgentPreview {
  const rules = loadRules(root);
  checkNewAgent(rules, a);
  const notes = loadBrain(root);
  checkNotAnArea(rules, notes, a.agent);
  const grant = grantFor(rules, a.agent, a.slices);
  grant.exclude_types = a.exclude_types ?? ["money"];
  grant.exclude = a.exclude ?? [];
  if (a.max_sensitivity) grant.ceiling = a.max_sensitivity;
  const res = carve(notes, rules, grant);
  const vis = [...res.visible.values()].map((v) => v.note);
  const kinds: Record<string, number> = {};
  for (const n of vis) { const k = n.fm.id.split("/")[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
  return {
    agent: a.agent,
    notes: vis.length,
    total: notes.length,
    areas: [...new Set(vis.map((n) => n.fm.area).filter((x): x is string => !!x))].sort(),
    kinds,
    money: vis.some((n) => n.fm.id.startsWith("money/") || n.fm.type === "money"),
    private: sensitivityRank(res.grant.ceiling) >= sensitivityRank("private"),
    ceiling: res.grant.ceiling,
    text: renderPreview(notes, res),
    sample: vis.slice(0, 6).map((n) => n.fm.title || n.fm.id),
  };
}

// Writes the agent into policy.yaml as trial, commits it as the owner and builds its view.
export function addAgent(root: string, a: NewAgent): NewAgentPreview {
  const p = previewNewAgent(root, a);
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  const exclude = a.exclude_types ?? ["money"];
  doc.setIn(["agents", a.agent], doc.createNode({
    ...(a.name ? { label: a.name.slice(0, 60) } : {}), tier: "trial", transport: a.transport ?? "mcp", slices: a.slices,
    ...(exclude.length ? { exclude_types: exclude } : {}),
    ...(a.exclude?.length ? { exclude: a.exclude } : {}), ...(a.max_sensitivity ? { max_sensitivity: a.max_sensitivity } : {}),
    ...(a.status ? { status: a.status } : {}), ...(a.windows?.length ? { windows: a.windows } : {}),
    ...(a.max_proposals_per_day !== undefined ? { max_proposals_per_day: a.max_proposals_per_day } : {}),
  }, { flow: true }));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: add ${a.agent} (trial, ${a.slices.join(", ")})`, "--", "rules/policy.yaml"], OWNER);
  const rules = loadRules(root);
  buildView(loadBrain(root), rules, carve(loadBrain(root), rules, grantFor(rules, a.agent)), root);
  return p;
}
