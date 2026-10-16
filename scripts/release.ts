// SPDX-License-Identifier: AGPL-3.0-only
// Releases: a version is a tag vX.Y.Z on main whose CHANGELOG section is dated. See docs/release.md.
//   bun scripts/release.ts check [--no-run]                    is main's tip releasable? (RELEASABLE or NOT RELEASABLE)
//   bun scripts/release.ts cut [patch|minor|major] [--no-run]  dated CHANGELOG section + package.json version on a
//                                                              claude/release-X.Y.Z branch, merged into main, tag vX.Y.Z
//   bun scripts/release.ts notes <tag>                         the CHANGELOG section for a tag (the GitHub release text)
//   bun scripts/release.ts verify-tag <tag>                    the tag matches package.json and a dated section (CI)
//   bun scripts/release.ts due                                 the tag CI should make on this commit, if any (CI)
// Nothing here pushes: `git push origin main` is a separate step (docs/release.md says who may run it), and
// CI makes the tag on GitHub (cloud sessions can push branches but not tags).
import { readFileSync, writeFileSync } from "node:fs";

export type Bump = "patch" | "minor" | "major";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current: string, bump: Bump): string {
  const m = current.match(SEMVER);
  if (!m) throw new Error(`not a version: ${current}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  return bump === "major" ? `${maj + 1}.0.0` : bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

// The changelog as sections: "## [Unreleased]", then "## [X.Y.Z] - YYYY-MM-DD" or "- unreleased".
interface Section { start: number; end: number; name: string; date: string; body: string }
function sections(text: string): Section[] {
  const heads = [...text.matchAll(/^## \[([^\]]+)\](?: - (\S+))?[^\n]*\n/gm)];
  return heads.map((h, i) => {
    const start = h.index!, bodyStart = start + h[0].length, end = i + 1 < heads.length ? heads[i + 1].index! : text.length;
    return { start, end, name: h[1], date: h[2] ?? "", body: text.slice(bodyStart, end).trim() };
  });
}

// What the next release would hold: the Unreleased entries, and a prepared "- unreleased" section
// right after it if there is one (its version wins over the bump).
export function pending(text: string): { version?: string; body: string } {
  const s = sections(text);
  const u = s.find((x) => x.name === "Unreleased");
  if (!u) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const next = s[s.indexOf(u) + 1];
  const prepared = next && next.date === "unreleased" ? next : undefined;
  return { version: prepared?.name, body: [u.body, prepared?.body ?? ""].filter(Boolean).join("\n\n") };
}

export function cutChangelog(text: string, o: { current: string; bump: Bump; date: string }): { text: string; version: string; notes: string } {
  const p = pending(text);
  if (!p.body) throw new Error("nothing to release: ## [Unreleased] is empty");
  const version = p.version ?? nextVersion(o.current, o.bump);
  const s = sections(text);
  const u = s.find((x) => x.name === "Unreleased")!;
  const after = s[s.indexOf(u) + 1];
  const cutEnd = p.version ? after.end : u.end;
  const out = `${text.slice(0, u.start)}## [Unreleased]\n\n## [${version}] - ${o.date}\n\n${p.body}\n\n${text.slice(cutEnd).replace(/^\n+/, "")}`;
  return { text: out.replace(/\n+$/, "\n"), version, notes: p.body };
}

export function notesFor(text: string, version: string): string {
  const s = sections(text).find((x) => x.name === version.replace(/^v/, ""));
  if (!s) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return s.body;
}

export function verifyTag(tag: string, pkgVersion: string, changelog: string): string[] {
  const v = tag.replace(/^v/, "");
  const fail: string[] = [];
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail.push(`tag ${tag} is not vX.Y.Z`);
  if (pkgVersion !== v) fail.push(`package.json says ${pkgVersion}, the tag says ${v}`);
  const s = sections(changelog).find((x) => x.name === v);
  if (!s) fail.push(`CHANGELOG.md has no ## [${v}] section`);
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) fail.push(`CHANGELOG.md's ${v} section is not dated (${s.date || "no date"})`);
  return fail;
}

// The tag CI makes on a push to main: package.json's version, when its CHANGELOG section is dated
// and no tag has it yet. Anything else (a plain merge, a "- unreleased" section) is not a release.
export function due(pkgVersion: string, changelog: string, tags: string[]): string | undefined {
  const tag = `v${pkgVersion}`;
  return !tags.includes(tag) && verifyTag(tag, pkgVersion, changelog).length === 0 ? tag : undefined;
}

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};
const pkg = () => JSON.parse(readFileSync("package.json", "utf8"));

// Releasable: main, nothing uncommitted, something in Unreleased, a free tag, and the checks pass.
export function releasable(o: { run: boolean; bump: Bump }): { version?: string; fail: string[] } {
  const fail: string[] = [];
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") fail.push(`on ${branch}; releases are cut from main`);
  if (git("status", "--porcelain", "--untracked-files=no")) fail.push("uncommitted changes");
  let version: string | undefined;
  try {
    const text = readFileSync("CHANGELOG.md", "utf8");
    const p = pending(text);
    if (!p.body) fail.push("nothing to release: ## [Unreleased] is empty");
    version = p.version ?? nextVersion(pkg().version, o.bump);
    if (git("tag", "--list", `v${version}`)) fail.push(`tag v${version} already exists`);
  } catch (e) { fail.push((e as Error).message); }
  if (o.run && !fail.length) {
    const c = Bun.spawnSync(["bun", "run", "check"], { stdout: "inherit", stderr: "inherit" });
    if (c.exitCode !== 0) fail.push("`bun run check` failed");
  }
  return { version, fail };
}

function main(argv: string[]): number {
  const [cmd, arg] = argv;
  const run = !argv.includes("--no-run");
  const bump = (["patch", "minor", "major"].includes(arg) ? arg : "patch") as Bump;
  if (cmd === "notes" && arg) { console.log(notesFor(readFileSync("CHANGELOG.md", "utf8"), arg)); return 0; }
  if (cmd === "verify-tag" && arg) {
    const fail = verifyTag(arg, pkg().version, readFileSync("CHANGELOG.md", "utf8"));
    for (const f of fail) console.log(`✗ ${f}`);
    console.log(fail.length ? "TAG DOES NOT MATCH" : `tag ${arg} matches package.json and CHANGELOG.md`);
    return fail.length ? 1 : 0;
  }
  if (cmd === "due") {
    const tag = due(pkg().version, readFileSync("CHANGELOG.md", "utf8"), git("tag", "--list", "v*").split("\n").filter(Boolean));
    if (tag) console.log(tag);
    return 0;
  }
  if (cmd === "check" || cmd === "cut") {
    const r = releasable({ run, bump });
    for (const f of r.fail) console.log(`✗ ${f}`);
    if (r.fail.length) { console.log("NOT RELEASABLE"); return 1; }
    if (cmd === "check") { console.log(`RELEASABLE as v${r.version}`); return 0; }
    const date = (process.env.PB_TODAY || new Date().toISOString()).slice(0, 10);
    const c = cutChangelog(readFileSync("CHANGELOG.md", "utf8"), { current: pkg().version, bump, date });
    const branch = `claude/release-${c.version}`;
    git("switch", "-c", branch);
    writeFileSync("CHANGELOG.md", c.text);
    const p = pkg(); p.version = c.version;
    writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    git("add", "CHANGELOG.md", "package.json");
    git("commit", "-q", "-m", `Release ${c.version}`, "-m", "No-Test: version and changelog only");
    git("switch", "main");
    git("merge", "--no-ff", "-q", "-m", `Merge ${branch}: release ${c.version}`, branch);
    git("tag", "-a", `v${c.version}`, "-m", `pocketBrain ${c.version}\n\n${c.notes}`);
    console.log(`tagged v${c.version} on main (${git("rev-parse", "--short", "HEAD")}). Next: git push origin main (CI tags it once green)`);
    return 0;
  }
  console.error("usage: bun scripts/release.ts check|cut [patch|minor|major] [--no-run] | notes <tag> | verify-tag <tag> | due");
  return 2;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
