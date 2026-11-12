// SPDX-License-Identifier: AGPL-3.0-only
// The owner sets a rules/ value with one command instead of a hand YAML edit (backlog #248).
// Each command edits only its own keys, keeps the file's other keys and comments, and commits that
// one file as the owner; on a replica it refuses and names the hub. Agents can't reach any of this:
// it's the CLI only, and the write path refuses rules/ (rules_read_only).
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { commitPaths } from "./git";
import { OWNER } from "./owner";
import { hubRole, loadHub } from "./hub";
import { loadRules, gardeners } from "./rules";
import { personKey, stripCredentials, isCredential, HONORIFIC } from "./write";
import { namesOwner, KIN_NOTE } from "./capture";
import { gardenerConfig } from "./gardener";
import type { OwnerErrorId, Vars } from "./owner-errors";
import { isTailnetIp, tailnetSettings } from "./dashboard/tailnet";
import { alert } from "./util";

export class OwnerSetError extends Error {}

// Sets (or, for undefined, removes) top-level keys of rules/<file>. Returns what changed.
export function setRulesKeys(root: string, file: string, patch: Record<string, unknown>, what: string): string {
  return editRules(root, file, (doc) => { for (const [k, v] of Object.entries(patch)) v === undefined ? doc.delete(k) : doc.set(k, v); }, what);
}

// The one place a rules file is edited and committed as the owner.
// `edit` changes the parsed doc, or returns the new text itself when a reprint would reflow the file.
function editRules(root: string, file: string, edit: (doc: YAML.Document, old: string) => string | void, what: string, o: { why?: string; dryRun?: boolean } = {}): string {
  if (!/^[a-z-]+\.yaml$/.test(file)) throw new OwnerSetError(`not a rules file: ${file}`);
  const role = hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") throw new OwnerSetError(`rules/ changes are made on the hub (${role.cfg.hub}); run this there`);
  const rel = `rules/${file}`, f = join(root, rel);
  const old = existsSync(f) ? readFileSync(f, "utf8") : "";
  const doc = old ? YAML.parseDocument(old) : new YAML.Document({});
  if (doc.errors.length) throw new OwnerSetError(`${rel} doesn't parse (${doc.errors[0].message.split("\n")[0]}); fix it by hand first`);
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  const text = edit(doc, old) ?? String(doc);
  if (text === old) return `${rel} already has ${what}`;
  if (o.dryRun) {
    const a = old.split("\n"), b = text.split("\n");
    const diff = a.length === b.length ? a.flatMap((l, i) => (l === b[i] ? [] : [`- ${l}`, `+ ${b[i]}`])) : [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)];
    return [`${rel}: ${what} (dry run, nothing written)`, ...diff].join("\n");
  }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  const unsaved = commitPaths(root, [rel], `owner: ${what} (${rel})${o.why ? `\n\nWhy: ${o.why}` : ""}`, OWNER);
  if (unsaved) {
    if (old) writeFileSync(f, old);
    throw new OwnerSetError(`${rel} not changed: the brain's git couldn't commit it (${unsaved})`);
  }
  return `${rel}: ${what}`;
}

const PROFILE = /^[A-Za-z0-9._-]{1,64}$/, VAULT = /^[A-Za-z0-9_-]{4,100}$/;
const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// `pocketbrain gardener setup`: rules/gardener.yaml's ant_profile, lock_file, agent and mcp_url,
// and the vault id in the two deployment files that `tend --managed` wrote beside the lock file.
export function gardenerSetup(root: string, o: { profile?: string; lock?: string; agent?: string; mcpUrl?: string; vault?: string }): string[] {
  if (o.profile !== undefined && !PROFILE.test(o.profile)) throw new OwnerSetError("--profile is letters, digits, . _ - only");
  if (o.lock !== undefined && !/\.json$/.test(o.lock)) throw new OwnerSetError("--lock is ant's lock file (claude-lock.json)");
  if (o.mcpUrl !== undefined && !/^https:\/\/[^/\s]+\/\S*$/.test(o.mcpUrl)) throw new OwnerSetError("--mcp-url must be https (Managed Agents connect from the internet)");
  if (o.agent !== undefined && !gardeners(loadRules(root)).includes(o.agent)) throw new OwnerSetError(`${o.agent} isn't a gardener in policy.yaml`);
  if (o.vault !== undefined && !VAULT.test(o.vault)) throw new OwnerSetError("--vault is the vault id from ant (letters, digits, _ -)");
  const have = gardenerConfig(root);
  if (!have && !o.lock) throw new OwnerSetError("no rules/gardener.yaml yet: pass --lock <your claude-lock.json> (pocketbrain tend --managed prints it)");
  const out: string[] = [];
  const patch = Object.fromEntries(Object.entries({ ant_profile: o.profile, lock_file: o.lock, agent: o.agent, mcp_url: o.mcpUrl }).filter(([, v]) => v !== undefined));
  if (Object.keys(patch).length) out.push(setRulesKeys(root, "gardener.yaml", patch, Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(", ")));
  if (o.vault) {
    const cfg = gardenerConfig(root)!, dir = dirname(resolve(expandHome(cfg.lock_file)));
    const agent = cfg.agent ?? gardeners(loadRules(root))[0];
    const files = [`agents/${agent}/deployment-nightly.yaml`, `agents/${agent}-weekly/deployment-weekly.yaml`].map((r) => join(dir, r)).filter((f) => existsSync(f));
    if (!files.length) throw new OwnerSetError(`no deployment files under ${dir}/agents/: run pocketbrain tend --managed first`);
    let n = 0;
    for (const f of files) { const t = readFileSync(f, "utf8"); if (t.includes("YOUR_VAULT_ID")) { writeFileSync(f, t.replace(/YOUR_VAULT_ID/g, o.vault)); n++; } }
    out.push(n ? `vault ${o.vault} in ${n} deployment file(s) under ${dir}` : `the deployment files under ${dir} already have a vault id`);
  }
  return out;
}

// `pocketbrain night managed|local`: who runs the nightly pass (docs/gardener.md). rules/hub.yaml
// once there is one, policy.yaml on a single machine (nightMode reads both).
export function setNight(root: string, mode: string): string {
  if (mode !== "managed" && mode !== "local") throw new OwnerSetError("night managed | local");
  return setRulesKeys(root, loadHub(root) ? "hub.yaml" : "policy.yaml", { night: mode }, `night ${mode}`);
}

// `pocketbrain dashboard tailnet on --device <100.x> | off` (docs/dashboard-tailnet.md): the
// dashboard on the owner's tailnet, for the devices listed. Added devices join the list; off keeps
// the list. hub.yaml once there is one, policy.yaml on a single machine (tailnetSettings reads both).
// `login` (from `pocketbrain phone`, this machine's own Tailscale login) is written only when no
// login is set yet: one the owner set is never replaced.
export function setDashboardTailnet(root: string, on: boolean, devices: string[] = [], login?: string): string {
  const file = loadHub(root) ? "hub.yaml" : "policy.yaml";
  const bad = devices.filter((d) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || !isTailnetIp(d));
  if (bad.length) throw new OwnerSetError(`--device is a device's Tailscale address (100.x.y.z, shown under its name in the Tailscale app), not ${bad.join(", ")}`);
  if (!on) return setRulesKeys(root, file, { dashboard_tailnet: false }, "dashboard_tailnet off");
  const have = tailnetSettings(root).dashboard_tailnet_devices ?? [];
  const list = [...new Set([...have, ...devices])];
  if (!list.length) throw new OwnerSetError("name the device that may open it: pocketbrain dashboard tailnet on --device <its Tailscale address>");
  const cur = tailnetSettings(root);
  const addLogin = login && !cur.dashboard_tailnet_login ? { dashboard_tailnet_login: login } : {};
  return setRulesKeys(root, file, { dashboard_tailnet: true, dashboard_tailnet_devices: list, ...addLogin }, `dashboard_tailnet on for ${list.join(", ")}${addLogin.dashboard_tailnet_login ? `, login ${login}` : ""}`);
}

// `pocketbrain wiki sync on|off`: whether the Gardener's wiki_sync writes pages or only reports
// what it would change (docs/wiki.md). Off until the owner says so.
export function setWikiSync(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("wiki sync on | off");
  return editRules(root, "policy.yaml", (doc) => { doc.setIn(["wiki", "sync"], mode === "on"); }, `wiki sync ${mode}`);
}

// `pocketbrain wiki opening on|off`: whether a page takes the Gardener's opening paragraph or the
// Gardener's wiki_sync only reports it (src/wiki.ts openingProblem, G713). Off until the owner says
// so. Kept beside wiki sync under `wiki:`, so turning one on leaves the other as it was.
export function setWikiOpening(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("wiki opening on | off");
  return editRules(root, "policy.yaml", (doc) => { doc.setIn(["wiki", "opening"], mode === "on"); }, `wiki opening ${mode}`);
}

// `pocketbrain machine-mail on|off`: whether the nightly pass sets aside the held facts assistants
// filed from machine mail or only counts them (src/receipt-pages.ts, G668). Off until the owner says so.
export function setMachineMailAside(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("machine-mail on | off");
  return setRulesKeys(root, "policy.yaml", { machine_mail: { set_aside: mode === "on" } }, `machine-mail ${mode}`);
}

// `pocketbrain fold on|off`: whether the nightly pass folds same-name project and org twins or only
// counts them (src/fold.ts, docs/fold-twins.md). Off until the owner says so.
export function setFoldTwins(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("fold on | off");
  return setRulesKeys(root, "policy.yaml", { fold: { twins: mode === "on" } }, `fold ${mode}`);
}

// `pocketbrain gardener describe-orgs [--yes]` (docs/gardener.md, "What an org is"): adds the one
// line `describe_orgs: true` to rules/gardener.yaml and nothing else. Refused when the key is there
// already, whatever its value: changing it back is the owner's own edit.
export const DESCRIBE_LINE = "describe_orgs: true";
export function setDescribeOrgs(root: string): string {
  const f = join(root, "rules", "gardener.yaml");
  const cur = existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) as Record<string, unknown> | null : null;
  if (cur && typeof cur === "object" && "describe_orgs" in cur) throw new OwnerSetError(`rules/gardener.yaml already has describe_orgs: ${String(cur.describe_orgs)}; nothing changed`);
  return setRulesKeys(root, "gardener.yaml", { describe_orgs: true }, "let the Gardener say what thin orgs are");
}

// `pocketbrain backfill on|off`: whether the nightly source backfill attaches the mail it finds or
// only reports what it would (src/backfill.ts nightBackfill, docs/sources-pull.md). Off until the
// owner says so.
export function setNightlyBackfill(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("backfill on | off");
  return setRulesKeys(root, "policy.yaml", { backfill: { nightly: mode === "on" } }, `backfill ${mode}`);
}

// `pocketbrain filing all on|off` (docs/filing.md, "File everything"): every fact a
// capture or source pull finds files itself, and only a conflict asks the owner. Off until the
// owner says so; the other auto_decide keys stay as they are.
export function setFileAll(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("filing all on | off");
  const f = join(root, "rules", "escalation.yaml");
  const cur = existsSync(f) ? (YAML.parse(readFileSync(f, "utf8")) as { auto_decide?: unknown } | null)?.auto_decide : undefined;
  const { file: _, ...rest } = cur && typeof cur === "object" && !Array.isArray(cur) ? cur as Record<string, unknown> : {};
  return setRulesKeys(root, "escalation.yaml", { auto_decide: { ...rest, file: mode === "on" ? "all" : "ask" } }, `file all ${mode}`);
}

// `pocketbrain next-steps newest` (docs/wiki.md, "Facts that follow each other"): next_step is a
// run of values, so a newer one files itself and the older one goes to history instead of waiting
// as a conflict. Sets `merge: latest` on project's next_step and on every other kind that declares
// one; its shelf life and the rest of checks.yaml stay as they are.
export function setNextStepNewest(root: string): string {
  const f = join(root, "rules", "checks.yaml");
  type Types = Record<string, { attributes?: Record<string, Record<string, unknown> | null> }>;
  const typesOf = (t: string) => (YAML.parse(t) as { types?: Types } | null)?.types ?? {};
  const types = existsSync(f) ? typesOf(readFileSync(f, "utf8")) : {};
  const kinds = [...new Set(["project", ...Object.keys(types).filter((t) => types[t]?.attributes?.next_step)])];
  const what = `next_step keeps the newest (${kinds.length} kind${kinds.length === 1 ? "" : "s"})`;
  const latest = (t: Types) => {
    for (const k of kinds) { const a = (t[k] ??= {}).attributes ??= {}; a.next_step = { ...(a.next_step ?? { shelf_life: "14d" }), merge: "latest" }; }
    return t;
  };
  const r = editRules(root, "checks.yaml", (doc, old) => {
    // The usual one-line `next_step: { merge: replace, … }` changes in place, so the rest of the
    // file stays as written; anything else is set through the parsed doc.
    const text = old.replace(/^(\s+next_step:\s*\{[^}\n]*\bmerge:\s*)[a-z]+/gm, "$1latest");
    if (Bun.deepEquals(typesOf(text), latest(typesOf(old))) && Bun.deepEquals({ ...YAML.parse(text), types: 0 }, { ...YAML.parse(old), types: 0 })) return text;
    for (const k of kinds) {
      const at = ["types", k, "attributes", "next_step"];
      if (!doc.hasIn(at)) doc.setIn(at, doc.createNode({ shelf_life: "14d" }, { flow: true }));
      doc.setIn([...at, "merge"], "latest");
    }
  }, what);
  return r.startsWith("rules/checks.yaml already") ? "rules/checks.yaml already has next_step keeps the newest" : r;
}

// `pocketbrain agent tier <agent> core|trial` (docs/gardener.md, "Letting the Gardener file"): the
// agent's tier, and going to core its daily proposal cap goes too (a core agent writes, it doesn't
// queue). The agent's own line changes in place; anything that would move another value is refused.
export function setAgentTier(root: string, agent: string, tier: string, o: { dryRun?: boolean } = {}): string {
  if (tier !== "core" && tier !== "trial") throw new OwnerSetError("agent tier <agent> core | trial");
  const rules = loadRules(root);
  if (!agent || !Object.hasOwn(rules.policy.agents, agent)) throw new OwnerSetError(`${agent || "(none)"} isn't an agent in rules/policy.yaml`);
  type Agents = Record<string, Record<string, unknown>>;
  const agentsOf = (t: string) => ((YAML.parse(t) as { agents?: Agents } | null)?.agents ?? {});
  const want = (old: string) => {
    const a = agentsOf(old), { max_proposals_per_day: cap, ...rest } = a[agent] ?? {};
    return { ...a, [agent]: { ...rest, tier, ...(tier === "core" || cap === undefined ? {} : { max_proposals_per_day: cap }) } };
  };
  const only = (text: string, old: string) => Bun.deepEquals(agentsOf(text), want(old)) && Bun.deepEquals({ ...YAML.parse(text), agents: 0 }, { ...YAML.parse(old), agents: 0 });
  const esc = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = editRules(root, "policy.yaml", (doc, old) => {
    // The usual one-line `<agent>: { tier: …, … }` changes in place, so the file stays as written.
    const line = new RegExp(`^(\\s+${esc}:\\s*\\{)([^\\n]*)(\\}\\s*(?:#.*)?)$`, "m");
    const text = old.replace(line, (_, a: string, body: string, z: string) => {
      let b = body.replace(/(^|,)(\s*)tier:\s*[A-Za-z_-]+/, `$1$2tier: ${tier}`);
      if (tier === "core") b = b.replace(/,\s*max_proposals_per_day:\s*\d+/, "").replace(/(\{?\s*)max_proposals_per_day:\s*\d+\s*,\s*/, "$1");
      return a + b + z;
    });
    if (only(text, old)) return text;
    // Any other shape: the parsed doc, and still only if nothing else moves.
    doc.setIn(["agents", agent, "tier"], tier);
    if (tier === "core") doc.deleteIn(["agents", agent, "max_proposals_per_day"]);
    const re = String(doc);
    if (!only(re, old)) throw new OwnerSetError(`rules/policy.yaml: changing ${agent}'s tier would change more than its tier and cap; change it by hand`);
    return re;
  }, `${agent} tier ${tier}`, {
    dryRun: o.dryRun,
    why: tier === "core"
      ? `the owner chose to let ${agent} write directly: its facts file themselves like any core agent's, with no daily proposal cap; a conflict still waits for the owner.`
      : `the owner put ${agent} back on trial: it proposes, and its proposals wait.`,
  });
  if (!o.dryRun && !r.includes("already")) {
    alert(root, { agent, check: "agent_tier", from: `pocketbrain agent tier ${agent} ${tier} changed ${agent}'s tier from a terminal. If that wasn't you: pocketbrain agent tier ${agent} ${tier === "core" ? "trial" : "core"}` });
  }
  return r;
}

// `pocketbrain wiki links on|off`: whether upkeep links a name that fits exactly one note or only
// reports the links it would add (docs/wiki.md, "Names become links"). On in a new brain's policy.
export function setLinkNames(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("wiki links on | off");
  return setRulesKeys(root, "policy.yaml", { link_names: mode === "on" }, `link_names ${mode}`);
}

// `pocketbrain wiki family on|off`: whether upkeep links a person page with the owner's surname to
// the owner's page as maybe family (src/family.ts, G546), or only counts them. Off until turned on.
export function setFamilyLinks(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("wiki family on | off");
  return setRulesKeys(root, "policy.yaml", { family_links: mode === "on" }, `family_links ${mode}`);
}

// `pocketbrain wiki parents on|off`: whether upkeep puts a project page under the page it is part of
// (src/wiki.ts parentPlan, G640), or only counts them. Off until turned on.
export function setPageParents(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("wiki parents on | off");
  return setRulesKeys(root, "policy.yaml", { page_parents: mode === "on" }, `page_parents ${mode}`);
}

// `pocketbrain wiki trips on|off`: whether upkeep puts a flight, stay or booking page under the trip
// whose dates hold it (src/page-kind.ts tripPlan, G787), or only counts them. On until turned off.
export function setTrips(root: string, mode: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("wiki trips on | off");
  return setRulesKeys(root, "policy.yaml", { trips: mode === "on" }, `trips ${mode}`);
}

// `pocketbrain aftercheck classify on|off [--cap <dollars>]`: the second-opinion classifier after an
// agent's write (src/aftercheck.ts, docs/aftercheck.md), off until the owner says so. `--cap` sets
// that step's own monthly spend cap (usage.cap.steps, docs/usage.md). Off keeps the cap.
export function setAftercheckClassify(root: string, mode: string, cap?: string): string {
  if (mode !== "on" && mode !== "off") throw new OwnerSetError("aftercheck classify on | off [--cap <dollars a month>]");
  if (cap !== undefined && !(/^\d+(\.\d+)?$/.test(cap) && Number(cap) > 0)) throw new OwnerSetError("--cap takes dollars a month, like --cap 1");
  const what = `aftercheck classify ${mode}${cap !== undefined ? `, write.classify capped at $${cap} a month` : ""}`;
  return editRules(root, "policy.yaml", (doc) => {
    doc.setIn(["aftercheck", "classify"], mode === "on");
    if (cap !== undefined) doc.setIn(["usage", "cap", "steps", "write.classify"], Number(cap));
  }, what);
}

// `pocketbrain hub url <https://…>`: the one address agents hold.
export function setPublicUrl(root: string, url: string): string {
  if (!loadHub(root)) throw new OwnerSetError("no rules/hub.yaml yet; start with pocketbrain hub init --name <machine>");
  if (!/^https:\/\/[^/\s?#]+\/?$/.test(url)) throw new OwnerSetError("the door is https://<host>, with no path");
  const u = url.replace(/\/$/, "");
  return setRulesKeys(root, "hub.yaml", { public_url: u }, `public_url ${u}`);
}

// `pocketbrain ask on|off` (docs/ask-to-see.md): policy.yaml's ask_to_see. `on` keeps the settings
// already there and changes only the flags given; `off` writes `ask_to_see: false`. A setting
// change made this way is configuration: it commits as the owner, so the real-use bar doesn't
// count it as a hand fix (handEdits, src/measure.ts). A hand edit of the same key still counts.
const NEVER = /^[a-z0-9_/-]{1,40}$/, CLIENT = /^[A-Za-z0-9]{10,64}$/;
export function setAskToSee(root: string, on: boolean, o: { approver?: string; never?: string; maxPerDay?: string; clientId?: string } = {}): string {
  if (!on) return setRulesKeys(root, "policy.yaml", { ask_to_see: false }, "ask_to_see off");
  if (o.approver !== undefined && o.approver !== "dashboard" && o.approver !== "guardian") throw new OwnerSetError("--approver dashboard | guardian");
  const never = o.never?.split(",").map((x) => x.trim()).filter(Boolean);
  if (never?.some((x) => !NEVER.test(x))) throw new OwnerSetError("--never is a comma list of types, folders or areas (money,health)");
  const max = o.maxPerDay === undefined ? undefined : Number(o.maxPerDay);
  if (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= 50)) throw new OwnerSetError("--max-per-day is a whole number from 1 to 50");
  if (o.clientId !== undefined && !CLIENT.test(o.clientId)) throw new OwnerSetError("--client-id is the Auth0 application's client id (letters and digits)");
  const had = loadRules(root).policy.ask_to_see;
  const cur: Record<string, unknown> = had && typeof had === "object" ? structuredClone(had) as Record<string, unknown> : {};
  const next = { ...cur, approver: o.approver ?? cur.approver ?? "dashboard", ...(never ? { never } : {}), ...(max !== undefined ? { max_per_day: max } : {}) } as Record<string, unknown>;
  if (o.clientId) next.guardian = { ...(cur.guardian as object | undefined), client_id: o.clientId };
  if (next.approver === "guardian" && !(next.guardian as { client_id?: string } | undefined)?.client_id) throw new OwnerSetError("--approver guardian needs --client-id <the Auth0 application with the CIBA grant>");
  const what = ["ask_to_see on", ...Object.entries({ approver: o.approver, never: never?.join(","), max_per_day: max, client_id: o.clientId }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`)].join(", ");
  return setRulesKeys(root, "policy.yaml", { ask_to_see: next }, what);
}

export const setFgaModel = (root: string, id: string): string => {
  if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new OwnerSetError("an FGA model id is letters and digits");
  return setRulesKeys(root, "fga.yaml", { model_id: id }, `model_id ${id}`);
};

// For doctor: each value the owner was told to set by hand and hasn't, with its command.
export function missingOwnerValues(root: string): { key: string; id: OwnerErrorId; vars?: Vars }[] {
  const out: { key: string; id: OwnerErrorId; vars?: Vars }[] = [];
  const hub = loadHub(root), role = hubRole(root);
  if (hub && role.mode === "hub" && !hub.public_url) out.push({ key: "public_url", id: "doctor.setup-door" });
  const g = gardeners(loadRules(root)), cfg = gardenerConfig(root);
  if (g.length && !cfg) out.push({ key: "gardener", id: "doctor.setup-gardener" });
  if (cfg) {
    const dir = join(dirname(resolve(expandHome(cfg.lock_file))), "agents");
    const left = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /deployment-.*\.yaml$/.test(f) && readFileSync(join(dir, f), "utf8").includes("YOUR_VAULT_ID")) : [];
    if (left.length) out.push({ key: "vault", id: "doctor.setup-vault", vars: { n: left.length } });
  }
  const fga = join(root, "rules", "fga.yaml");
  if (existsSync(fga) && !YAML.parse(readFileSync(fga, "utf8"))?.model_id) out.push({ key: "fga", id: "doctor.setup-fga" });
  return out;
}

const GENERATION = new Set(["jr", "sr", "ii", "iii", "iv", "fils", "pere"]);

// `pocketbrain me name`: the owner's full name as an alias in rules/policy.yaml, so a mail that
// writes it ("<first> <last>, M.Sc.") lands on the owner's page and never starts a new note
// (src/capture.ts ownerOf). Mac, 2026-10-25: owner.name was the first name alone, so it never
// fired. The full name must hold owner.name as a word. What it prints never holds the name.
export function setOwnerAliases(root: string, full: string, more: string[] = []): string {
  const owner = loadRules(root).policy.owner;
  if (!owner?.name) throw new OwnerSetError("rules/policy.yaml has no owner.name; set it first");
  const name = stripCredentials(full).replace(/\s+/g, " ").trim();
  const words = personKey(name).split(" ");
  if (words.length < 2) throw new OwnerSetError("me name: give your first and last name");
  if (!personKey(owner.name).split(" ").every((w) => words.includes(w))) throw new OwnerSetError("me name: the full name has to include your owner name");
  // Other spellings of the same name (G408): each holds every word of the full name, nothing more.
  const extra = more.map((x) => stripCredentials(x).replace(/\s+/g, " ").trim()).filter((x) => { const w = personKey(x).split(" "); return w.length === words.length && words.every((y) => w.includes(y)) && personKey(x) !== personKey(name); });
  const fresh = [name, ...extra];
  const aliases = [...(owner.aliases ?? []).filter((a) => !fresh.some((x) => personKey(a) === personKey(x))), ...fresh];
  return setRulesKeys(root, "policy.yaml", { owner: { ...owner, aliases } }, `owner aliases: ${aliases.length} (${words.length} words added)`);
}

// The full name the open proposals most often give the owner: a person title that holds
// owner.name as a word, credentials off, "Last, First" turned round, from the capture agent's
// proposals only. Undefined unless seen twice and at least twice as often as the next one, and
// never a Jr./Sr. (slice audit, G402: one namesake's mail, or another agent, named the owner).
export function suggestOwnerName(root: string): string | undefined {
  return ownerGroups(root)?.name;
}

// Every spelling of that name in the open proposals ("Last First", with credentials or a note in
// brackets), so each one resolves to the owner once set as an alias (G408).
export function ownerSpellings(root: string): string[] {
  return ownerGroups(root)?.spellings ?? [];
}

// Counts only, never a name: why `me name --suggested` found one or not (Mac, 2026-10-25: it said
// nothing the Mac could act on).
export function ownerNameReport(root: string): string {
  const st = { person: 0, notCapture: 0, oneWord: 0, otherName: 0, generation: 0 };
  ownerGroups(root, st);
  const g = lastGroups.map((x) => x.n).sort((a, b) => b - a);
  return `person proposals ${st.person}: not from the capture pipeline or a core assistant ${st.notCapture}, one word ${st.oneWord}, without your name ${st.otherName}, Jr./Sr. ${st.generation}; names holding yours ${g.length} (sightings ${g.join(", ") || "none"}); a name needs 2 sightings and twice the next one`;
}
let lastGroups: { n: number }[] = [];

function ownerGroups(root: string, st?: { person: number; notCapture: number; oneWord: number; otherName: number; generation: number }): { name: string; spellings: string[] } | undefined {
  const rules = loadRules(root), first = rules.policy.owner?.name;
  if (!first) return undefined;
  const want = personKey(first).split(" ");
  // One name however it is spelled: accents, case, credentials, a title, a note in brackets and a
  // surname in capitals put first set aside; an initial still keeps two people apart (G399).
  const groups = new Map<string, { n: number; spellings: string[] }>();
  for (const sub of ["inbox", join("inbox", "held")]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
      let doc: { by?: unknown; capture?: unknown; request?: { title?: unknown; type?: unknown } } | undefined;
      try { doc = YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      const r = doc?.request;
      if (r?.type !== "person" || typeof r.title !== "string") continue;
      if (st) st.person++;
      if (!namesOwner(rules, doc)) { if (st) st.notCapture++; continue; }
      if (KIN_NOTE.test(r.title)) { if (st) st.generation++; continue; }
      const bare = stripCredentials(r.title.replace(/\s*\([^)]*\)/g, "").replace(/\S+@\S+/g, "").trim());
      const parts = bare.split(",").map((x) => x.trim());
      let name = (parts.length === 2 ? [parts[1], parts[0]] : [bare]).join(" ").replace(/\s+/g, " ").replace(HONORIFIC, "").trim();
      // A degree after the name without a comma ("<first> <last> M.Sc."), two name words kept.
      for (let w = name.split(" "); w.length > 2 && isCredential(w[w.length - 1]); w = name.split(" ")) name = w.slice(0, -1).join(" ");
      // "LAST First": a surname in capitals first goes last. Any other order stays as written:
      // "James Thomas" is not "Thomas James" (slice audit, G408).
      const written = name, words = name.split(" ");
      if (words.length >= 2 && /^\p{Lu}{2,}$/u.test(words[0]) && !words.slice(1).every((w) => /^\p{Lu}{2,}$/u.test(w))) name = [...words.slice(1), words[0]].join(" ");
      const ws = personKey(name).split(" ");
      // A son's or father's name is not the owner's.
      if (ws.length < 2) { if (st) st.oneWord++; continue; }
      if (!want.every((w) => ws.includes(w))) { if (st) st.otherName++; continue; }
      if (ws.some((w) => GENERATION.has(w))) { if (st) st.generation++; continue; }
      const k = ws.join(" ");
      const g = groups.get(k) ?? { n: 0, spellings: [] };
      g.n++;
      // Kept as written, so the alias matches the mail's own spelling.
      if (!g.spellings.some((x) => personKey(x) === personKey(written))) g.spellings.push(written);
      groups.set(k, g);
    }
  }
  const top = [...groups.values()].sort((a, b) => b.n - a.n);
  lastGroups = top;
  if (!top[0] || top[0].n < 2 || top[0].n < 2 * (top[1]?.n ?? 0)) return undefined;
  // The page's name: the spelling that starts with the owner's name and isn't all capitals.
  const rank = (x: string) => (personKey(x).startsWith(`${want[0]} `) ? 0 : 2) + (x === x.toUpperCase() || /\b[A-Z]{2,}\b/.test(x) ? 1 : 0);
  const spellings = [...top[0].spellings].sort((a, b) => rank(a) - rank(b));
  return { name: spellings[0], spellings };
}
