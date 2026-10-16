// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain uninstall` (docs/quickstart.md#leaving): every place pocketBrain put something on
// this Mac, as a plan the owner reads first. With --yes it stops each launchd job, then removes its
// file, the logs, the tunnel config pocketBrain wrote, the menu-bar app and the keys folder. The
// brain and its backups stay unless --remove-brain (the brain only; backups are never touched).
// What lives in the owner's accounts (sign-in clients, the tunnel, the gardener's deployments) is
// listed with the exact command or page: removing it reaches outside this Mac, so the owner does it.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { Run } from "./menubar";
import { MARK } from "./door";
import { loadHub } from "./hub";
import { loadOAuth } from "./oauth";
import { gardenerConfig, lockIds } from "./gardener";
import { loadBackupConfig, destOf } from "./backup";

export type UninstallStep =
  | { kind: "stop"; label: string; cmd: string[] }
  | { kind: "remove"; path: string; what: string }
  | { kind: "keep"; path: string; what: string }
  | { kind: "by-hand"; what: string; lines: string[] };

const PREFIX = "com.pocketbrain.";
const inside = (dir: string, p: string) => { const r = relative(resolve(dir), resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
const ours = (dir: string, ext: RegExp) => existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(PREFIX) && ext.test(f)).sort() : [];

const backupDir = (brain: string) => { try { return destOf(brain, loadBackupConfig(brain)); } catch { return undefined; /* no backups set up */ } };

export function uninstallPlan(o: { home: string; config: string; brain?: string; uid: number; removeBrain?: boolean }): UninstallStep[] {
  const steps: UninstallStep[] = [];
  const brain = o.brain && existsSync(o.brain) ? resolve(o.brain) : undefined;
  if (o.removeBrain) {
    if (!brain || !existsSync(join(brain, "rules", "policy.yaml"))) throw new Error(`${o.brain ?? "no brain found"} isn't a brain (no rules/policy.yaml); nothing removed`);
    if (brain === resolve(o.home) || inside(brain, o.home) || brain === "/") throw new Error(`${brain} is your home folder or holds it; move the brain into its own folder first`);
  }

  // launchd: stop every job first (the hub writes to the brain while it runs), then its file.
  const la = join(o.home, "Library", "LaunchAgents");
  const plists = ours(la, /\.plist$/);
  for (const f of plists) { const label = f.replace(/\.plist$/, ""); steps.push({ kind: "stop", label, cmd: ["launchctl", "bootout", `gui/${o.uid}/${label}`] }); }
  for (const f of plists) steps.push({ kind: "remove", path: join(la, f), what: "launchd job" });
  // The hub's log holds the dashboard's login link.
  const logs = join(o.home, "Library", "Logs");
  for (const f of ours(logs, /\.(log|err|out)$/)) steps.push({ kind: "remove", path: join(logs, f), what: "log" });

  // The tunnel config, only when `pocketbrain door install` wrote it, and the credentials it names
  // only inside ~/.cloudflared. cloudflared's own login (cert.pem) is the owner's.
  const cf = join(o.home, ".cloudflared");
  const cfg = join(cf, "config.yml");
  if (existsSync(cfg)) {
    const text = readFileSync(cfg, "utf8");
    if (text.startsWith(MARK)) {
      steps.push({ kind: "remove", path: cfg, what: "tunnel config" });
      const cred = text.match(/^credentials-file: (.+)$/m)?.[1]?.trim();
      if (cred && inside(cf, cred) && cred.endsWith(".json") && existsSync(cred)) steps.push({ kind: "remove", path: resolve(cred), what: "tunnel credentials" });
    } else steps.push({ kind: "keep", path: cfg, what: "tunnel config (pocketBrain didn't write it)" });
  }

  const app = join(o.home, "Applications", "PocketBrain.app");
  if (existsSync(app)) steps.push({ kind: "remove", path: app, what: "menu-bar app" });
  if (existsSync(o.config)) {
    const isBrain = brain && existsSync(join(brain, "rules", "policy.yaml"));
    const backups = isBrain ? backupDir(brain) : undefined;
    const holds = (p?: string) => !!p && (resolve(p) === resolve(o.config) || inside(o.config, p));
    if (holds(o.home) || holds(brain) || holds(backups)) steps.push({ kind: "keep", path: o.config, what: "settings folder (it holds your home folder, brain or backups)" });
    else steps.push({ kind: "remove", path: o.config, what: "keys folder and settings" });
  }

  if (brain && existsSync(join(brain, "rules", "policy.yaml"))) {
    const hand: UninstallStep[] = [];
    const oauth = loadOAuth(brain);
    const clients = [
      ...Object.entries(oauth?.clients ?? {}).map(([id, c]) => `${id} (${c.agent}${c.name ? `, ${c.name}` : ""})`),
      ...Object.entries(oauth?.machines ?? {}).map(([id, c]) => `${id} (${c.agent})`),
      ...Object.values(oauth?.coworkers ?? {}).flatMap((w) => Object.keys(w.clients ?? {}).map((id) => `${id} (${w.agent}, ${w.name}'s)`)),
    ];
    if (oauth) hand.push({ kind: "by-hand", what: `Sign-in clients: delete each in your sign-in provider (${oauth.issuer}, Applications)`, lines: clients.length ? clients : ["none bound"] });
    const h = loadHub(brain);
    if (h?.tunnel?.kind === "cloudflare" && h.tunnel.name) hand.push({ kind: "by-hand", what: "The tunnel and its address, in your Cloudflare account", lines: [`cloudflared tunnel delete ${h.tunnel.name}`, ...(h.public_url ? [`then delete the DNS record for ${h.public_url.replace(/^https?:\/\//, "")} in the Cloudflare dashboard`] : [])] });
    const g = gardenerConfig(brain);
    if (g) {
      const ids = lockIds(g);
      const a = `env -u ANTHROPIC_API_KEY ant --profile ${g.ant_profile}`;
      hand.push({ kind: "by-hand", what: "The gardener, in your Anthropic account (pause first so nothing runs against a door that's gone)", lines: ids?.deployments.length
        ? [...ids.deployments.map((d) => `${a} beta:deployments pause --deployment-id ${d}`), `then delete the deployments, the gardener agents${ids.vault ? ` and vault ${ids.vault}` : " and their vault"} in the Console`]
        : [`no deployment ids in ${g.lock_file}: look for the gardener's deployments in the Console`] });
    }
    steps.push(...hand);
    steps.push(o.removeBrain ? { kind: "remove", path: brain, what: "brain" } : { kind: "keep", path: brain, what: "brain" });
    const d = backupDir(brain);
    if (d && existsSync(d)) steps.push({ kind: "keep", path: d, what: "backups" });
  }
  return steps;
}

export function planText(steps: UninstallStep[]): string {
  if (!steps.some((s) => s.kind === "stop" || s.kind === "remove")) return ["nothing of pocketBrain's is installed here", ...keepLines(steps)].join("\n");
  const out = ["pocketbrain uninstall would:"];
  for (const s of steps) {
    if (s.kind === "stop") out.push(`  stop ${s.label}: ${s.cmd.join(" ")}`);
    else if (s.kind === "remove") out.push(`  remove the ${s.what}: ${s.path}`);
  }
  out.push(...keepLines(steps));
  const hand = steps.filter((s): s is Extract<UninstallStep, { kind: "by-hand" }> => s.kind === "by-hand");
  if (hand.length) { out.push("", "In your accounts (not done for you):"); for (const s of hand) out.push(`  ${s.what}:`, ...s.lines.map((l) => `    ${l}`)); }
  return out.join("\n");
}
const keepLines = (steps: UninstallStep[]) => steps.filter((s) => s.kind === "keep").map((s) => `  keep your ${s.what}: ${s.path}`);

export function runUninstall(steps: UninstallStep[], o: { run: Run }): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === "stop") { const r = o.run(s.cmd); out.push(r.code === 0 ? `stopped ${s.label}` : `${s.label} wasn't running`); }
    else if (s.kind === "remove") { rmSync(s.path, { recursive: true, force: true }); out.push(`removed the ${s.what}: ${s.path}`); }
    else if (s.kind === "keep") out.push(`kept your ${s.what}: ${s.path}`);
  }
  const hand = steps.filter((s): s is Extract<UninstallStep, { kind: "by-hand" }> => s.kind === "by-hand");
  if (hand.length) { out.push("", "Still to do in your accounts:"); for (const s of hand) out.push(`  ${s.what}:`, ...s.lines.map((l) => `    ${l}`)); }
  return out;
}
