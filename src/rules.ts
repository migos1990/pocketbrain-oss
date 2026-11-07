// SPDX-License-Identifier: AGPL-3.0-only
// rules/ folder: policy.yaml (agents, areas, owners), slices.yaml (carving),
// checks.yaml (enforced checks and per-type attribute settings). Only Louis edits these.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Sensitivity, FactRecord } from "./brain";
import { cleanStanding, readStandingYaml } from "./standing";
import { setOwnerZone, zoneDay } from "./clock";

export interface AgentPolicy {
  tier: "core" | "trial";
  // This agent's token budget per call (src/context.ts); over the policy-wide one.
  context_budget?: Record<string, number>;
  transport?: "paste" | "mcp" | "api";
  aliases?: string[];
  slices?: string[];
  exclude_types?: string[];
  exclude?: string[];
  max_sensitivity?: Sensitivity;
  inside_wall?: boolean;
  pasted_to?: string[];
  // Louis's kill switches, enforced by the server, the write path and the relay:
  // paused = no reads, no writes, mail held; read-only = reads only.
  status?: "active" | "paused" | "read-only";
  // The agent that keeps the brain in order (docs/gardener.md). Gardener rules check this flag,
  // never the name: its own tools, the proposal cap, its hours, out of the use signal.
  role?: "gardener";
  // Most inbox proposals in 24 hours (unset: no cap).
  max_proposals_per_day?: number;
  max_verifies_per_day?: number; // gardener: verify_source checks per day (src/pull.ts, default 40)
  // When its token may be used, in owner.timezone: "daily 03:25-05:00", "sun 09:55-12:00",
  // "mon-fri 08:00-09:00". Outside them the token pauses the agent (src/gardener.ts).
  windows?: string[];
  // How the owner sees this agent named on screens and on the phone ("claude.ai" for agent claude).
  label?: string;
  // Where this agent keeps memory the hub can read on this machine (Claude Code's CLAUDE.md and
  // memory folders): files or folders of .md, ~ allowed. Agents without it are quizzed instead
  // (src/memsync.ts).
  memory?: { files?: string[] };
  // The browser door (/b, src/browser.ts): this agent may sign in on a web form with its token.
  // For assistants whose vault only fills web pages. Off unless set.
  browser?: boolean;
  // A person the owner shares slices with, live and read-only, until a date (src/share.ts). The
  // limits that come with it are applied in loadRules, so no entry point can skip them.
  collaborator?: { name: string; until: string; ended?: string };
  // What this agent may do, beyond knowing (src/act.ts, docs/act.md): send one mail, to the listed
  // addresses or domains only, each held for the owner's dashboard approval. Validated in
  // loadRules, which drops it for every agent kind that gets no actions in v1.
  act?: ActBlock;
}

// One list entry: an exact address or "@" plus a domain (that domain only, no subdomains). The
// owner names it (label) for the text that says a mail waits; max_sensitivity raises the outward
// screen's ceiling for this recipient (default public).
export interface ActEntry { to: string; label?: string; max_sensitivity?: Sensitivity }
export interface ActBlock {
  send_mail?: { to: ActEntry[]; max_per_day?: number; max_requests_per_day?: number };
}

// A second owner for named areas (docs/household.md): their word counts like the owner's there
// and nowhere else; their assistants are held to those areas in loadRules.
export interface CoOwner { name: string; areas: string[]; agents: string[] }

export interface Policy {
  // How agents are told to refer to the brain's owner ("ask <name>"). Set by `pocketbrain init`.
  // aliases: other full names the owner goes by ("Robin Lake"), so mail about them lands on their page.
  owner?: { name: string; timezone?: string; aliases?: string[] };
  agents: Record<string, AgentPolicy>;
  // Every agent's token budget per call (src/context.ts, docs/hub.md "Context budget").
  context_budget?: Record<string, number>;
  areas: Record<string, { owner?: string; label?: string }>;
  resolver?: string;
  // The agent that reads Louis's texts (default: the resolver). Its citations of his messages
  // register them, below private, and each one shows in the digest for Louis to see.
  // The agent that carries the owner's texts (default: the resolver). louis_channel is the legacy key.
  owner_channel?: string;
  louis_channel?: string;
  // Louis's editor (set from the dashboard; none by default): this agent's writes skip the
  // trial and area-owner routing and apply directly. Every check, the tripwire, the
  // injection and secret checks, rules/ protection and the kill switches still apply.
  owner_editor?: string;
  co_owners?: Record<string, CoOwner>;
  tiers?: Record<string, { max_sensitivity: Sensitivity; writes: "direct" | "propose" }>;
  // Prices, caps and what happens past a cap (src/usage.ts). Never copied into a cell.
  usage?: import("./usage").UsagePolicy;
  // Checks right after an agent write (src/aftercheck.ts): the quick gardener, on by default when
  // its model has a key, and the second-opinion classifier, off until set to true.
  aftercheck?: import("./aftercheck").AftercheckPolicy;
  // The relay's request check (src/relay.ts, step 3c): off unless `classify: true` and a key for relay.flag is loaded.
  relay?: import("./relay").RelayPolicy;
  // Who runs the nightly pass: the hub itself (local, the default) or the gardener (managed),
  // with the hub stepping in when the gardener has been silent 36 hours. hub.yaml wins.
  night?: "local" | "managed";
  // The dashboard on the owner's tailnet (docs/dashboard-tailnet.md), on a single machine; hub.yaml
  // wins once there is one. Set with `pocketbrain dashboard tailnet on --device <100.x>`.
  dashboard_tailnet?: boolean;
  dashboard_tailnet_login?: string;
  dashboard_tailnet_devices?: string[];
  // Ask to see (src/asks.ts, docs/ask-to-see.md): an agent asks for something outside its cut and
  // the owner approves one read, on their phone (Auth0 Guardian) or in the dashboard. Off unless set.
  ask_to_see?: import("./asks").AskPolicy | boolean;
  // The act door's owner-wide cap: mails sent (owner-approved) in 24 hours, all agents (default 10).
  act?: { max_per_day?: number };
}

export interface Slice {
  areas?: string[];
  types?: string[];
  tags?: string[];
  exclude_tags?: string[];
  max_sensitivity?: Sensitivity;
  since?: string;
  until?: string;
  only_attributes?: string[];
  exclude_attributes?: string[];
  include?: string[];
  exclude?: string[];
  bodies?: boolean;
  announce?: boolean;
  // An assistant waiting for approval may have this slice pre-checked on its access request
  // (docs/add-an-agent.md). Area slices always may; named slices only with this set.
  requestable?: boolean;
}

export interface AttributeSpec {
  // latest: values that follow each other (build numbers, versions): the newest is kept, earlier
  // ones go to history, and a same-day or older value never opens a dispute (backlog 403).
  merge?: "replace" | "set" | "max" | "min" | "append" | "latest";
  normalize?: "text" | "email" | "e164" | "date" | "money" | "link";
  shelf_life?: string; // "180d", "until_date" (stale once the date in its value has passed)
  item_key?: string;
  // Set by attributeSpec for DATED attributes: like until_date, on top of any shelf life.
  ends_on_date?: boolean;
}

export interface Checks {
  checks: string[];
  types: Record<string, { sensitivity?: Sensitivity; attributes?: Record<string, AttributeSpec> }>;
  // Words that mark a type an agent may be denied (money: salary, TFSA…).
  categories?: Record<string, string[]>;
}

// rules/standing.yaml (docs/standing.md, src/standing.ts): who matters to the owner. Priority only;
// nothing that decides a check reads it.
export type StandingTier = "inner" | "close" | "known";
// note_created: the note the owner placed (its `created`), so a deleted note recreated under the same id
// by an agent doesn't inherit the standing.
export interface StandingEntry { tier: StandingTier; authority?: "owner" | "them"; addresses?: string[]; note_created?: string }
export interface StandingFile { me?: string[]; people: Record<string, StandingEntry> }

export interface Rules {
  policy: Policy;
  slices: Record<string, Slice>;
  checks: Checks;
  guidance: string;
  standing?: StandingFile;
  // act blocks dropped because they didn't validate (agent: why); doctor shows them.
  actProblems?: string[];
}

export function readYaml<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return (YAML.parse(readFileSync(file, "utf8")) as T) ?? fallback;
}

export function loadRules(root: string): Rules {
  const dir = join(root, "rules");
  const policy = readYaml<Policy>(join(dir, "policy.yaml"), { agents: {}, areas: {} });
  const slicesFile = readYaml<{ slices: Record<string, Slice> }>(join(dir, "slices.yaml"), { slices: {} });
  const checks = readYaml<Checks>(join(dir, "checks.yaml"), { checks: [], types: {} });
  const guidance = existsSync(join(dir, "RULES.md")) ? readFileSync(join(dir, "RULES.md"), "utf8") : "";
  const slices: Record<string, Slice> = { ...(slicesFile.slices ?? {}) };
  // Every area gets a ready-made slice (architecture 0.7), plus "all".
  for (const area of Object.keys(policy.areas ?? {})) slices[`area:${area}`] ??= { areas: [area] };
  slices["all"] ??= {};
  checkRoles(policy);
  for (const name of RESERVED_AGENTS) if (policy.agents?.[name]) throw new Error(`rules/policy.yaml: ${name} is a name the hub's own commits carry; give that assistant another name`);
  limitCollaborators(policy);
  checkCoOwners(policy);
  // A co-owner area's slice is that area, nothing more: slices.yaml can't widen it.
  for (const [id, c] of Object.entries(policy.co_owners ?? {})) for (const area of c.areas)
    if (slicesFile.slices?.[`area:${area}`]) throw new Error(`rules/slices.yaml: co-owner ${id}: area:${area} is defined by the co-owner's area; remove it from slices.yaml`);
  const actProblems = limitActs(policy);
  setOwnerZone(policy.owner?.timezone);
  return { policy, slices, checks, guidance, standing: cleanStanding(readStandingYaml(join(dir, "standing.yaml"))), ...(actProblems.length ? { actProblems } : {}) };
}

// Names no assistant may take: the hub's own commits carry them (docs/filing.md).
export const RESERVED_AGENTS = ["auto-decide", "hub"];

// A gardener reads everything and only proposes, so it must stay an outside agent with no say:
// never the resolver, never an area owner. A policy that breaks this doesn't load.
function checkRoles(policy: Policy) {
  for (const [name, a] of Object.entries(policy.agents ?? {})) {
    if (!a?.role) continue;
    if (a.role !== "gardener") throw new Error(`rules/policy.yaml: agent ${name} has unknown role "${a.role}" (only gardener)`);
    if (a.inside_wall) throw new Error(`rules/policy.yaml: ${name} has role gardener, so it can't be inside_wall`);
    if (policy.resolver === name) throw new Error(`rules/policy.yaml: ${name} has role gardener, so it can't be the resolver`);
    const owns = Object.entries(policy.areas ?? {}).filter(([, x]) => x?.owner === name).map(([k]) => k);
    if (owns.length) throw new Error(`rules/policy.yaml: ${name} has role gardener, so it can't own an area (${owns.join(", ")})`);
  }
}

// One of the owner's own assistants, with a memory of its own to keep in line: not a tool inside the
// wall, not the Gardener, and never a person's: a collaborator's (re-audit 2026-10-30, G529: quiz(),
// the belief radar and the home's "Your assistants" took one for the owner's) or a household
// co-owner's (G533).
export function ownAssistant(rules: Rules, name: string): boolean {
  const a = rules.policy.agents[name];
  if (!a || a.inside_wall || a.role === "gardener" || a.collaborator) return false;
  return !Object.values(rules.policy.co_owners ?? {}).some((c) => c?.agents?.includes(name));
}

// A collaborator (src/share.ts) is a person, not one of the owner's assistants. Whatever
// policy.yaml says: trial, read-only, paused past its date, personal at most, money out, never the
// all slice, never the resolver, an area owner, named after an area or the owner's text channel.
// Code, not prose: everything reads rules from here.
const SHARE_CEILING: Sensitivity = "personal";
const RANK: Record<string, number> = { public: 0, personal: 1, private: 2, secret: 3 };
function limitCollaborators(policy: Policy) {
  const day = process.env.PB_TODAY ?? zoneDay(policy.owner?.timezone); // the owner's day, as share.ts sets until (G286)
  for (const [name, a] of Object.entries(policy.agents ?? {})) {
    if (!a?.collaborator) continue;
    if (policy.resolver === name) throw new Error(`rules/policy.yaml: ${name} is a collaborator, so it can't be the resolver`);
    const owns = Object.entries(policy.areas ?? {}).filter(([, x]) => x?.owner === name).map(([k]) => k);
    if (owns.length) throw new Error(`rules/policy.yaml: ${name} is a collaborator, so it can't own an area (${owns.join(", ")})`);
    if (a.inside_wall || a.role) throw new Error(`rules/policy.yaml: ${name} is a collaborator, so it can't be inside the wall or have a role`);
    if (policy.owner_channel === name || policy.louis_channel === name) throw new Error(`rules/policy.yaml: ${name} is a collaborator, so it can't carry the owner's texts (owner_channel)`);
    // write.ts treats an agent named after an area as that area's owner, and carve shows it
    // what it wrote there as its own (src/carve.ts, G176).
    if (policy.areas?.[name]) throw new Error(`rules/policy.yaml: ${name} is a collaborator named after an area; give it another name`);
    a.tier = "trial";
    a.slices = (a.slices ?? []).filter((x) => x !== "all");
    a.exclude_types = [...new Set([...(a.exclude_types ?? []), "money"])];
    if (!a.max_sensitivity || (RANK[a.max_sensitivity] ?? 3) > RANK[SHARE_CEILING]) a.max_sensitivity = SHARE_CEILING;
    // A date that isn't YYYY-MM-DD (a hand edit) fails closed: the string compare below needs it.
    const until = String(a.collaborator.until ?? "");
    a.status = a.collaborator.ended || !/^\d{4}-\d{2}-\d{2}$/.test(until) || day > until || a.status === "paused" ? "paused" : "read-only";
  }
}

// Co-owners (docs/household.md). Whatever a hand edit says, a co-owner's assistant reads only
// its co-owner's areas, personal at most and never money, and holds none of the owner's roles; a
// policy that gives it one doesn't load. Only the owner edits rules/, so only he names co-owners.
const CAPS: Sensitivity[] = ["public", "personal"];
function checkCoOwners(policy: Policy) {
  const seen = new Map<string, string>();
  for (const [id, c] of Object.entries(policy.co_owners ?? {})) {
    const bad = (why: string) => { throw new Error(`rules/policy.yaml: co-owner ${id}: ${why}`); };
    if (!c || typeof c.name !== "string" || !c.name.trim()) bad("needs a name");
    if (!Array.isArray(c.areas) || !c.areas.length) bad("needs areas");
    if (!Array.isArray(c.agents) || !c.agents.length) bad("needs agents");
    for (const area of c.areas) if (typeof area !== "string" || !policy.areas?.[area]) bad(`area "${area}" isn't an area in policy.yaml`);
    for (const name of c.agents) {
      const a = policy.agents?.[name];
      if (!a) bad(`agent ${name} isn't in policy.yaml`);
      if (seen.has(name)) bad(`agent ${name} is already co-owner ${seen.get(name)}'s`);
      seen.set(name, id);
      // carve shows an agent every note in an area named after it (src/carve.ts).
      if (policy.areas?.[name] && !c.areas.includes(name)) bad(`agent ${name} is named after the ${name} area; give it another name`);
      if (a?.collaborator) bad(`agent ${name} is a collaborator's (a guest), so it can't be a co-owner's`);
      for (const role of ["resolver", "owner_channel", "louis_channel", "owner_editor"] as const)
        if (policy[role] === name) bad(`agent ${name} can't be the owner's ${role}`);
      if (captureAgentName(policy) === name) bad(`agent ${name} can't be the owner's capture channel`);
      if (a.inside_wall) bad(`agent ${name} can't be inside_wall`);
      if (a.role) bad(`agent ${name} can't have role ${a.role}`);
      const owns = Object.entries(policy.areas ?? {}).filter(([k, x]) => x?.owner === name && !c.areas.includes(k)).map(([k]) => k);
      if (owns.length) bad(`agent ${name} can't own ${owns.join(", ")}, outside the co-owner's areas`);
      a.slices = (a.slices ?? []).filter((x) => c.areas.some((area) => x === `area:${area}`));
      if (!CAPS.includes(a.max_sensitivity as Sensitivity)) a.max_sensitivity = "personal";
      a.exclude_types = [...new Set([...(a.exclude_types ?? []), "money"])];
    }
  }
}
// The owner's word, or a co-owner's on a fact in that co-owner's areas: both rank as the owner's
// (docs/household.md). The label counts only on a record that co-owner's own assistant wrote or
// confirmed there; a hand-written or moved one is worth no more than its sources.
export function isOwnerWord(rules: Rules, area: string | undefined, r: FactRecord): boolean {
  if (r.verification === "confirmed-by-owner" || r.verification === "confirmed-by-louis") return true;
  if (r.verification !== "confirmed-by-co-owner" || !r.co_owner || !area) return false;
  const c = rules.policy.co_owners?.[r.co_owner];
  return !!c && c.areas.includes(area) && c.agents.includes(r.confirmed_by ?? r.by);
}

export function coOwnerOf(rules: Rules, agent: string): { id: string; areas: string[] } | undefined {
  for (const [id, c] of Object.entries(rules.policy.co_owners ?? {})) if (c.agents.includes(agent)) return { id, areas: c.areas };
  return undefined;
}

// The act door's limits (docs/act.md), enforced here so no entry point can skip them. An agent
// keeps its act block only if it is an active outside agent that isn't a collaborator, a
// co-owner's assistant, the gardener, the resolver or the agent that carries the owner's texts (it would describe to the
// owner the actions it asked for). A block that doesn't validate is dropped (fails closed) and
// named in actProblems; a shared mail provider as a domain entry stops the rules loading, since
// it would open the list to anyone who signs up there.
export const SHARED_PROVIDERS = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "yahoo.com", "ymail.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "fastmail.com", "hey.com", "tutanota.com", "qq.com", "163.com"];
const ADDRESS = /^[a-z0-9._-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
const DOMAIN = /^@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
export const validDomain = (d: string) => d.split(".").every((l) => l.length > 0 && !l.startsWith("-") && !l.endsWith("-") && !l.startsWith("xn--"));
export const validAddress = (a: string) => ADDRESS.test(a) && validDomain(a.split("@")[1]);
function limitActs(policy: Policy): string[] {
  const problems: string[] = [];
  const channel = policy.owner_channel ?? policy.louis_channel ?? policy.resolver;
  const posInt = (n: unknown) => n === undefined || (Number.isInteger(n) && (n as number) > 0);
  if (policy.act !== undefined && (typeof policy.act !== "object" || policy.act === null || !posInt(policy.act.max_per_day))) {
    problems.push("policy act.max_per_day must be a positive whole number; using 0 (no mail is sent)");
    policy.act = { max_per_day: 0 };
  }
  for (const [name, a] of Object.entries(policy.agents ?? {})) {
    if (!a || a.act === undefined) continue;
    const drop = (why?: string) => { if (why) problems.push(`${name}: ${why}`); delete a.act; };
    // A co-owner's assistant never acts in v1 (docs/household.md): the owner can loosen this later.
    const coOwned = Object.values(policy.co_owners ?? {}).some((c) => c?.agents?.includes(name));
    if (a.collaborator || a.role || a.inside_wall || coOwned || name === policy.resolver || name === channel || (a.status ?? "active") !== "active") { drop(); continue; }
    const m = (a.act as ActBlock | null)?.send_mail;
    if (!a.act || typeof a.act !== "object" || Object.keys(a.act).some((k) => k !== "send_mail") || !m || typeof m !== "object") { drop("act takes one action, send_mail"); continue; }
    if (!Array.isArray(m.to) || !m.to.length) { drop("act.send_mail.to must be a list of addresses or @domains"); continue; }
    if (!posInt(m.max_per_day) || !posInt(m.max_requests_per_day)) { drop("act.send_mail caps must be positive whole numbers"); continue; }
    const entries: ActEntry[] = [];
    let bad: string | undefined;
    for (const raw of m.to as unknown[]) {
      const e = typeof raw === "string" ? { to: raw } : raw as ActEntry;
      const to = typeof e?.to === "string" ? e.to : "";
      if (DOMAIN.test(to) && validDomain(to.slice(1))) {
        if (SHARED_PROVIDERS.includes(to.slice(1))) throw new Error(`rules/policy.yaml: ${name} act.send_mail lists ${to}, a shared mail provider; list the exact address instead`);
      } else if (!validAddress(to)) { bad = `act.send_mail.to has an entry that is neither an exact address nor @domain (${JSON.stringify(to).slice(0, 60)})`; break; }
      if (e.label !== undefined && (typeof e.label !== "string" || !/^[\p{L}\p{N} .,'&()-]{1,40}$/u.test(e.label))) { bad = "an act.send_mail.to label must be 1 to 40 letters, digits or spaces"; break; }
      if (e.max_sensitivity !== undefined && !["public", "personal", "private"].includes(e.max_sensitivity)) { bad = "an act.send_mail.to max_sensitivity must be public, personal or private"; break; }
      entries.push({ to, ...(e.label ? { label: e.label } : {}), ...(e.max_sensitivity ? { max_sensitivity: e.max_sensitivity } : {}) });
    }
    if (bad) { drop(bad); continue; }
    a.act = { send_mail: { to: entries, ...(m.max_per_day ? { max_per_day: m.max_per_day } : {}), ...(m.max_requests_per_day ? { max_requests_per_day: m.max_requests_per_day } : {}) } };
  }
  return problems;
}

// The agent may ask for actions (after loadRules has dropped every block it may not keep).
export const actOn = (rules: Rules, agent: string) => !!rules.policy.agents[agent]?.act?.send_mail?.to?.length;

export const isGardener = (rules: Rules, agent: string) => rules.policy.agents[agent]?.role === "gardener";
// Who a capture's or a pull's facts are written as (capture.ts captureAgent): the owner's channel,
// else the resolver, else the hub's own `capture` agent that init writes (G422), else "instinct"
// (brains made before it).
export const captureAgentName = (policy: Rules["policy"]): string =>
  policy.owner_channel ?? policy.louis_channel ?? policy.resolver ?? (policy.agents?.capture?.inside_wall ? "capture" : "instinct");

export const gardeners = (rules: Rules) => Object.entries(rules.policy.agents).filter(([, a]) => a.role === "gardener").map(([n]) => n);

// The owner's name as agents read it in views and refusals.
export function ownerName(rules: Rules): string {
  return rules.policy.owner?.name?.trim() || "the owner";
}

export function tierOf(rules: Rules, agent: string) {
  const a = rules.policy.agents[agent];
  if (!a) throw new Error(`unknown agent "${agent}" (not in rules/policy.yaml)`);
  const tier = rules.policy.tiers?.[a.tier] ?? (a.tier === "trial"
    ? { max_sensitivity: "personal" as Sensitivity, writes: "propose" as const }
    : { max_sensitivity: "private" as Sensitivity, writes: "direct" as const });
  return { ...tier, max_sensitivity: a.max_sensitivity ?? tier.max_sensitivity };
}

// Attributes that end on the date they name: past it, a next step or a due date is no longer the plan.
export const DATED = ["next_step", "due", "deadline"];
// Attributes every brain has, whatever checks.yaml says (checks.yaml still wins where it names one).
// prefers: how a person likes things done, in the words an assistant's memory or a note used
// ("prefers email over phone calls"). A vendor's memory is mostly this, so an import keeps it as
// prose, one item per line, instead of losing it (outside review 2026-10-29, G490).
export const BUILTIN: Record<string, Record<string, AttributeSpec>> = {
  person: { prefers: { merge: "set", normalize: "text" } },
};
// What a contact card fills (src/contacts.ts) where checks.yaml says nothing: who someone is to the
// owner, and what the card calls them. Never in the extraction prompt, and a model's candidate for
// one is not captured (cardOnly): only a card's line proposes them. A nickname is a fact, never a
// name the brain matches pages on.
export const CARD_ATTRS: Record<string, Record<string, AttributeSpec>> = {
  person: { relationship: { merge: "replace", normalize: "text" }, aliases: { merge: "set", normalize: "text" } },
};
export const cardOnly = (rules: Rules, type: string, attribute: string) =>
  !!CARD_ATTRS[type]?.[attribute] && !(rules.checks.types?.[type]?.attributes?.[attribute] ?? BUILTIN[type]?.[attribute]);
// Whether checks.yaml or the built-ins say anything about this kind of fact (attributeSpec gives {} when not).
export function isDeclared(rules: Rules, type: string, attribute: string): boolean {
  return !!(rules.checks.types?.[type]?.attributes?.[attribute] ?? BUILTIN[type]?.[attribute] ?? CARD_ATTRS[type]?.[attribute]);
}

// Project attributes that are a run of values over time unless rules/checks.yaml says otherwise.
// Projects only: a person's build or a contract's version is not a release stream.
export const LATEST = ["version", "build", "build_number", "latest_version", "latest_build", "app_version"];

export function attributeSpec(rules: Rules, type: string, attribute: string): AttributeSpec {
  let s = rules.checks.types?.[type]?.attributes?.[attribute] ?? BUILTIN[type]?.[attribute] ?? CARD_ATTRS[type]?.[attribute] ?? {};
  if (type === "project" && LATEST.includes(attribute) && !s.merge) s = { ...s, merge: "latest" };
  return DATED.includes(attribute) ? { ...s, ends_on_date: true } : s;
}

// Maps any name an agent has gone by (Vamprose, "Vamprose / Town") to its policy key.
export function agentAlias(rules: Rules, name: string): string | undefined {
  const n = name.trim().toLowerCase();
  for (const [key, a] of Object.entries(rules.policy.agents)) {
    if (key === n || (a.aliases ?? []).some((x) => x.toLowerCase() === n)) return key;
  }
  return undefined;
}

export function shelfLifeDays(spec: AttributeSpec): number | undefined {
  const m = spec.shelf_life?.match(/^(\d+)d$/);
  return m ? Number(m[1]) : undefined;
}
