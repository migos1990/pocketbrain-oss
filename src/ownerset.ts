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
import { gardenerConfig } from "./gardener";

export class OwnerSetError extends Error {}

// Sets (or, for undefined, removes) top-level keys of rules/<file>. Returns what changed.
export function setRulesKeys(root: string, file: string, patch: Record<string, unknown>, what: string): string {
  if (!/^[a-z-]+\.yaml$/.test(file)) throw new OwnerSetError(`not a rules file: ${file}`);
  const role = hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") throw new OwnerSetError(`rules/ changes are made on the hub (${role.cfg.hub}); run this there`);
  const rel = `rules/${file}`, f = join(root, rel);
  const old = existsSync(f) ? readFileSync(f, "utf8") : "";
  const doc = old ? YAML.parseDocument(old) : new YAML.Document({});
  if (doc.errors.length) throw new OwnerSetError(`${rel} doesn't parse (${doc.errors[0].message.split("\n")[0]}); fix it by hand first`);
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  for (const [k, v] of Object.entries(patch)) v === undefined ? doc.delete(k) : doc.set(k, v);
  const text = String(doc);
  if (text === old) return `${rel} already has ${what}`;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  const unsaved = commitPaths(root, [rel], `owner: ${what} (${rel})`, OWNER);
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

// `pocketbrain hub url <https://…>`: the one address agents hold.
export function setPublicUrl(root: string, url: string): string {
  if (!loadHub(root)) throw new OwnerSetError("no rules/hub.yaml yet; start with pocketbrain hub init --name <machine>");
  if (!/^https:\/\/[^/\s?#]+\/?$/.test(url)) throw new OwnerSetError("the door is https://<host>, with no path");
  const u = url.replace(/\/$/, "");
  return setRulesKeys(root, "hub.yaml", { public_url: u }, `public_url ${u}`);
}

export const setFgaModel = (root: string, id: string): string => {
  if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new OwnerSetError("an FGA model id is letters and digits");
  return setRulesKeys(root, "fga.yaml", { model_id: id }, `model_id ${id}`);
};

// For doctor: each value the owner was told to set by hand and hasn't, with its command.
export function missingOwnerValues(root: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const hub = loadHub(root), role = hubRole(root);
  if (hub && role.mode === "hub" && !hub.public_url) out.push({ key: "public_url", text: "no public door in rules/hub.yaml: pocketbrain hub url https://brain.<your domain>" });
  const g = gardeners(loadRules(root)), cfg = gardenerConfig(root);
  if (g.length && !cfg) out.push({ key: "gardener", text: "the gardener's Anthropic side isn't recorded: pocketbrain tend --managed, then pocketbrain gardener setup --profile pocketbrain --lock ~/pocketbrain-agents/claude-lock.json" });
  if (cfg) {
    const dir = join(dirname(resolve(expandHome(cfg.lock_file))), "agents");
    const left = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /deployment-.*\.yaml$/.test(f) && readFileSync(join(dir, f), "utf8").includes("YOUR_VAULT_ID")) : [];
    if (left.length) out.push({ key: "vault", text: `${left.length} deployment file(s) still say YOUR_VAULT_ID: pocketbrain gardener setup --vault <vault id>` });
  }
  const fga = join(root, "rules", "fga.yaml");
  if (existsSync(fga) && !YAML.parse(readFileSync(fga, "utf8"))?.model_id) out.push({ key: "fga", text: "rules/fga.yaml has no model_id: pocketbrain fga model (writes the model and saves its id)" });
  return out;
}
