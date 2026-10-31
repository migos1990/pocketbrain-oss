// SPDX-License-Identifier: AGPL-3.0-only
// The dependency gate before anything goes public (docs/release.md#dependencies):
//   bun scripts/deps.ts licenses   every installed package's license is on the allowlist
//   bun scripts/deps.ts lock       bun.lock is tracked and every CI install is --frozen-lockfile
//   bun scripts/deps.ts sbom       a CycloneDX SBOM of what the npm package pulls in, on stdout
// CI runs `licenses` and `lock`, and `bun audit` for advisories; the release attaches the SBOM.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Licenses that can ship beside AGPL-3.0 code: permissive ones, and the GPL family's
 *  AGPL-compatible versions. GPL-2.0-only, SSPL, BUSL and "UNLICENSED" are not on it. */
export const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "MPL-2.0",
  "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0", "Zlib", "CC-BY-4.0",
  "GPL-2.0-or-later", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later",
  "AGPL-3.0-only", "AGPL-3.0-or-later",
]);

/** Packages whose license field is missing or off the list but were read by hand. Each needs a
 *  reason, and the check fails once the reason no longer matches an installed version. */
export const REVIEWED: Record<string, { version: string; license: string; why: string }> = {};

export interface Pkg { name: string; version: string; license: string; dir: string; deps: string[] }

function licenseOf(j: Record<string, unknown>): string {
  if (typeof j.license === "string") return j.license.trim();
  if (j.license && typeof j.license === "object" && typeof (j.license as { type?: unknown }).type === "string") return (j.license as { type: string }).type;
  if (Array.isArray(j.licenses)) {
    const t = j.licenses.map((l) => (l && typeof l === "object" ? (l as { type?: string }).type : l)).filter((x): x is string => typeof x === "string");
    if (t.length) return t.length === 1 ? t[0]! : `(${t.join(" OR ")})`;
  }
  return "";
}

/** Every package under node_modules, nested ones included. A package.json inside a package
 *  (a vendored copy, a browser build) is that package's own business, not a separate install. */
export function installed(root = ROOT): Pkg[] {
  const out: Pkg[] = [];
  const visit = (nm: string) => {
    if (!existsSync(nm)) return;
    for (const e of readdirSync(nm)) {
      if (e.startsWith(".")) continue;
      const dirs = e.startsWith("@") ? readdirSync(join(nm, e)).map((s) => join(nm, e, s)) : [join(nm, e)];
      for (const dir of dirs) {
        const pj = join(dir, "package.json");
        if (!existsSync(pj)) continue;
        const j = JSON.parse(readFileSync(pj, "utf8"));
        out.push({ name: j.name, version: j.version, license: licenseOf(j), dir, deps: Object.keys({ ...j.dependencies, ...j.optionalDependencies }) });
        visit(join(dir, "node_modules"));
      }
    }
  };
  visit(join(root, "node_modules"));
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** An SPDX expression is allowed when every AND part is, and at least one side of each OR is. */
export function allowed(expr: string, allow: Set<string> = ALLOWED): boolean {
  const toks = expr.replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  let i = 0;
  const or = (): boolean => {
    let v = and();
    while (toks[i] === "OR") { i++; v = and() || v; }
    return v;
  };
  const and = (): boolean => {
    let v = atom();
    while (toks[i] === "AND") { i++; v = atom() && v; }
    return v;
  };
  const atom = (): boolean => {
    const t = toks[i++];
    if (t === "(") { const v = or(); if (toks[i++] !== ")") throw new Error("unbalanced"); return v; }
    if (!t || t === ")" || t === "AND" || t === "OR") throw new Error("bad expression");
    if (toks[i] === "WITH") i += 2; // an exception only ever adds permissions
    return allow.has(t.replace(/\+$/, "-or-later"));
  };
  try {
    const v = or();
    return i === toks.length && v;
  } catch {
    return false;
  }
}

export function licenseProblems(pkgs: Pkg[], reviewed = REVIEWED, allow = ALLOWED): string[] {
  const out: string[] = [];
  for (const p of pkgs) {
    if (allowed(p.license, allow)) continue;
    const r = reviewed[p.name];
    if (r && r.version === p.version && r.license === p.license) continue;
    out.push(`${p.name}@${p.version}: ${p.license || "no license field"}${r ? " (reviewed for another version; read it again)" : ""}`);
  }
  return out;
}

export function lockProblems(root = ROOT): string[] {
  const out: string[] = [];
  if (!existsSync(join(root, "bun.lock"))) out.push("bun.lock is missing");
  const ls = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "bun.lock"], { cwd: root });
  if (ls.exitCode !== 0 && existsSync(join(root, ".git"))) out.push("bun.lock is not tracked");
  const wf = join(root, ".github", "workflows");
  for (const f of existsSync(wf) ? readdirSync(wf) : []) {
    readFileSync(join(wf, f), "utf8").split("\n").forEach((line, n) => {
      if (/\bbun install\b/.test(line) && !line.includes("--frozen-lockfile")) out.push(`.github/workflows/${f}:${n + 1}: bun install without --frozen-lockfile`);
    });
  }
  return out;
}

/** What `npm install pocketbrain` brings in: the package's dependencies and theirs, resolved the
 *  way Node does (nearest node_modules first). Dev tools are left out; they never ship. */
export function runtime(root = ROOT, pkgs = installed(root)): Pkg[] {
  const byDir = new Map(pkgs.map((p) => [p.dir, p]));
  const resolve = (from: string, name: string): Pkg | undefined => {
    for (let d = from; d.startsWith(root); d = join(d, "..")) {
      const p = byDir.get(join(d, "node_modules", name));
      if (p) return p;
      if (d === root) break;
    }
    return undefined;
  };
  const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const seen = new Map<string, Pkg>();
  const walk = (from: string, names: string[]) => {
    for (const n of names) {
      const p = resolve(from, n);
      if (!p || seen.has(p.dir)) continue;
      seen.set(p.dir, p);
      walk(p.dir, p.deps);
    }
  };
  walk(root, Object.keys({ ...top.dependencies, ...top.optionalDependencies }));
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function sbom(root = ROOT): object {
  const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const purl = (p: { name: string; version: string }) => `pkg:npm/${p.name.replace(/^@/, "%40")}@${p.version}`;
  const lic = (l: string) => (l ? [/\s(AND|OR|WITH)\s/.test(l) || l.startsWith("(") ? { expression: l } : { license: { id: l } }] : []);
  const comps = runtime(root);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: { type: "application", "bom-ref": purl(top), name: top.name, version: top.version, purl: purl(top), licenses: lic(top.license ?? "") },
    },
    components: comps.map((p) => ({ type: "library", "bom-ref": purl(p), name: p.name, version: p.version, purl: purl(p), licenses: lic(p.license) })),
    dependencies: [
      { ref: purl(top), dependsOn: Object.keys(top.dependencies ?? {}).map((n) => comps.find((c) => c.name === n)).filter((c): c is Pkg => !!c).map(purl) },
      ...comps.map((p) => ({ ref: purl(p), dependsOn: p.deps.map((n) => comps.find((c) => c.name === n)).filter((c): c is Pkg => !!c).map(purl) })),
    ],
  };
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "licenses") {
    const pkgs = installed();
    if (!pkgs.length) { console.error("no node_modules: run bun install --frozen-lockfile first"); process.exit(1); }
    const bad = licenseProblems(pkgs);
    if (bad.length) {
      console.error(`licenses: ${bad.length} package(s) off the allowlist (scripts/deps.ts ALLOWED). Replace it, or read its license and add it to REVIEWED with why:`);
      for (const b of bad) console.error(`  ${b}`);
      process.exit(1);
    }
    console.log(`licenses: ${pkgs.length} packages, all on the allowlist`);
  } else if (cmd === "lock") {
    const bad = lockProblems();
    for (const b of bad) console.error(`lock: ${b}`);
    if (bad.length) process.exit(1);
    console.log("lock: bun.lock is tracked and every CI install is frozen");
  } else if (cmd === "sbom") {
    console.log(JSON.stringify(sbom(), null, 2));
  } else {
    console.error("usage: bun scripts/deps.ts licenses|lock|sbom");
    process.exit(2);
  }
}
