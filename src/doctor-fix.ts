// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain doctor --fix (backlog 266). A doctor line whose repair is safe, known and needs no
// value from the owner names it in `fix`. `doctor --fix` prints what each repair would do and
// changes nothing; `doctor --fix --yes` runs them in a fixed order, logs one hand fix for the
// real-use bar (src/measure.ts), and runs doctor again. Everything else keeps its hand-written
// next step: a vault id, a token rotation, a snapshot to paste are the owner's.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { clearStaleLock } from "./git";
import { loadHub, tunnelConfig } from "./hub";
import { setPublicUrl, setRulesKeys } from "./ownerset";
import { backup } from "./backup";
import { recordFix } from "./measure";
import { TUNNEL_LABEL } from "./menubar";
import { doorHost, tunnelFile, type Finding, type Ingress } from "./doctor";

export interface Fix { preview: (root: string) => string; run: (root: string) => string }

// Rewrites only `ingress:` (pocketbrain hub tunnel-config's rules, on the door's hostname); the
// tunnel name, credentials file and comments stay. The old file is kept beside it as .bak.
function rewriteIngress(root: string): string {
  const cfg = loadHub(root), tf = tunnelFile(cfg), host = doorHost(cfg);
  if (!tf || !host) throw new Error("no tunnel config or hostname to rewrite");
  const old = readFileSync(tf, "utf8"), doc = YAML.parseDocument(old);
  if (doc.errors.length) throw new Error(`${tf} doesn't parse; fix it by hand`);
  const ingress = (YAML.parse(tunnelConfig(root)).ingress as Ingress).map((r) => (r.hostname ? { ...r, hostname: host } : r));
  doc.set("ingress", ingress);
  copyFileSync(tf, `${tf}.bak`);
  writeFileSync(tf, String(doc));
  return `${tf}: only the agent API on ${host}, then 404 (old file at ${tf}.bak). Restart the tunnel: launchctl kickstart -k gui/$(id -u)/${TUNNEL_LABEL}`;
}

const host = (root: string) => doorHost(loadHub(root) ?? undefined);

// In the order they run: the lock first (later repairs commit), the backup last (it takes them in).
export const FIXES: Record<string, Fix> = {
  lock: {
    preview: () => "remove .git/index.lock, left by a git command that was killed",
    run: (root) => (clearStaleLock(root) ? "removed the stale .git/index.lock" : "the lock is gone already, or a git command is using it now"),
  },
  "gardener-config": {
    preview: () => "write rules/gardener.yaml with ant_profile: pocketbrain (the lock file stays the default, ~/pocketbrain-agents/claude-lock.json)",
    run: (root) => setRulesKeys(root, "gardener.yaml", { ant_profile: "pocketbrain" }, "ant_profile pocketbrain"),
  },
  "public-url": {
    preview: (root) => `pocketbrain hub url https://${host(root)} (the hostname the tunnel serves)`,
    run: (root) => setPublicUrl(root, `https://${host(root)}`),
  },
  tunnel: {
    preview: (root) => `rewrite the ingress in ${tunnelFile(loadHub(root) ?? undefined)} to the agent API only, ending in 404; the old file is kept as .bak, and the tunnel needs a restart after`,
    run: rewriteIngress,
  },
  backup: {
    preview: () => "pocketbrain backup: one encrypted backup now",
    run: (root) => { const r = backup(root); return `backup ${r.file} at ${r.head.slice(0, 8)}`; },
  },
};

export interface Planned { id: string; preview: string; for: string[] }
export interface Done { id: string; ok: boolean; text: string }

export function fixPlan(root: string, findings: Finding[], fixes: Record<string, Fix> = FIXES): Planned[] {
  return Object.keys(fixes).filter((id) => findings.some((f) => f.fix === id))
    .map((id) => ({ id, preview: fixes[id].preview(root), for: findings.filter((f) => f.fix === id).map((f) => `${f.area}: ${f.text}`) }));
}

// Runs each planned repair once; a failure is reported and the rest still run. Logged as one hand
// fix naming what ran, since the owner had to step in.
export function applyFixes(root: string, findings: Finding[], fixes: Record<string, Fix> = FIXES): Done[] {
  const done: Done[] = [];
  for (const p of fixPlan(root, findings, fixes)) {
    try { done.push({ id: p.id, ok: true, text: fixes[p.id].run(root) }); } catch (e) { done.push({ id: p.id, ok: false, text: (e as Error).message }); }
  }
  const ran = done.filter((d) => d.ok).map((d) => d.id);
  if (ran.length) recordFix(root, `ran pocketbrain doctor --fix: ${ran.join(", ")}`, "auto:doctor-fix");
  return done;
}

export function renderPlan(plan: Planned[]): string {
  if (!plan.length) return "nothing doctor can repair by itself; the lines above say what to do";
  return [`doctor can repair ${plan.length} thing(s); nothing has changed yet:`, ...plan.flatMap((p) => [`  ${p.id}: ${p.preview}`, ...p.for.map((f) => `      for ${f}`)]), "run pocketbrain doctor --fix --yes to do it"].join("\n");
}

export const renderDone = (done: Done[]): string => done.map((d) => `${d.ok ? "fixed " : "FAILED"}  ${d.id}: ${d.text}`).join("\n");
