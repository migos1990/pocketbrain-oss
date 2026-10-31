// SPDX-License-Identifier: AGPL-3.0-only
// The public repo and pocketbrain.dev in step with what is built (docs/release.md "The public repo and the site"):
//   - the public repo (pocketbrain-oss, beside this repo under the same owner) holds the export of main's tip: CI's public-sync workflow
//     exports every main commit that passed CI (scripts/public-export.sh, gitleaks) and pushes it there,
//     one commit each, whose message names the private commit it came from;
//   - the site names one version, in `data-pb-version`, and only a tagged one: the newest tag.
//   bun scripts/public-sync.ts check [--site <file|url>] [--no-site] [--no-public]   IN SYNC or OUT OF SYNC
//   bun scripts/public-sync.ts message <sha> <version>                                the public commit's message (CI)
//   bun scripts/public-sync.ts leaks <gitleaks report.json> <.gitleaksignore>         fail on any finding not already known (CI)
import { readFileSync } from "node:fs";

// The public repo is `pocketbrain-oss` beside origin under the same owner (no owner name in a tracked
// file: the handle is on the denylist), or PB_PUBLIC_REPO.
export function publicRepoFor(origin: string): string {
  return origin.replace(/\/[^/]+?(\.git)?$/, "/pocketbrain-oss");
}
export const SITE_URL = "https://pocketbrain.dev/";
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function latestTag(tags: string[]): string | undefined {
  const key = (t: string) => t.match(SEMVER_TAG)!.slice(1).map(Number);
  return tags.filter((t) => SEMVER_TAG.test(t)).sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).at(-1);
}

export function siteVersion(html: string): string | undefined {
  return html.match(/data-pb-version="(\d+\.\d+\.\d+)"/)?.[1];
}

export function siteVerdict(version: string | undefined, tags: string[]): string[] {
  const newest = latestTag(tags);
  if (!version) return ["the site names no version (data-pb-version)"];
  if (!tags.includes(`v${version}`)) return [`the site names ${version}, which is not a tag (newest tag ${newest ?? "none"})`];
  if (`v${version}` !== newest) return [`the site names ${version}; the newest tag is ${newest}: refresh the site`];
  return [];
}

// The public commit names only the version and the private sha: a private commit's subject can
// mention what the public repo must not.
export function publicMessage(sha: string, version: string): string {
  return `pocketBrain ${version} (main)\n\nSource: ${sha}\n`;
}

export function sourceOf(message: string): string | undefined {
  return message.match(/^Source: ([0-9a-f]{40})$/m)?.[1];
}

export function publicVerdict(pub: { message: string; version: string }, main: { sha: string; version: string }): string[] {
  const fail: string[] = [];
  const src = sourceOf(pub.message);
  if (!src) fail.push("the public repo's last commit names no source commit");
  else if (src !== main.sha) fail.push(`the public repo holds main ${src.slice(0, 8)}; main is at ${main.sha.slice(0, 8)}`);
  if (pub.version !== main.version) fail.push(`the public repo says ${pub.version}; main says ${main.version}`);
  return fail;
}

// gitleaks over the export (a folder, no history): a finding passes only where .gitleaksignore already
// lets the same rule fire in the same test file on the private history; its fingerprints there carry
// commit and line, which the export doesn't have. Anything else stops the push.
export function unexpectedLeaks(findings: { File: string; RuleID: string; StartLine: number }[], ignore: string): string[] {
  const known = new Set(ignore.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(":").slice(1, 3).join(":")));
  return findings.filter((f) => !known.has(`${f.File.replace(/^\.\//, "")}:${f.RuleID}`)).map((f) => `${f.File}:${f.RuleID}:${f.StartLine}`);
}

const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

async function readSite(where: string): Promise<string> {
  if (/^https?:/.test(where)) {
    const r = await fetch(where, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${where}: HTTP ${r.status}`);
    return r.text();
  }
  return readFileSync(where, "utf8");
}

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (cmd === "message" && argv[1] && argv[2]) { process.stdout.write(publicMessage(argv[1], argv[2])); return 0; }
  if (cmd === "leaks" && argv[1] && argv[2]) {
    const bad = unexpectedLeaks(JSON.parse(readFileSync(argv[1], "utf8") || "[]"), readFileSync(argv[2], "utf8"));
    for (const b of bad) console.log(`✗ secret-shaped string not in .gitleaksignore: ${b}`);
    console.log(bad.length ? "LEAKS: nothing is pushed" : "no leak beyond the known test fixtures");
    return bad.length ? 1 : 0;
  }
  if (cmd !== "check") {
    console.error("usage: bun scripts/public-sync.ts check [--site <file|url>] [--no-site] [--no-public] | message <sha> <version> | leaks <report.json> <ignore file>");
    return 2;
  }
  const fail: string[] = [];
  const tags = run(["git", "ls-remote", "--tags", "--refs", "origin", "v*"]).split("\n").filter(Boolean).map((l) => l.split("refs/tags/")[1]);
  if (!argv.includes("--no-site")) {
    const i = argv.indexOf("--site");
    const where = i > 0 && argv[i + 1] ? argv[i + 1] : SITE_URL;
    try { fail.push(...siteVerdict(siteVersion(await readSite(where)), tags)); }
    catch (e) { fail.push(`the site could not be read: ${(e as Error).message}`); }
  }
  if (!argv.includes("--no-public")) {
    try {
      run(["git", "fetch", "-q", "origin", "main"]);
      const mainSha = run(["git", "rev-parse", "FETCH_HEAD"]);
      const mainVersion = JSON.parse(run(["git", "show", `${mainSha}:package.json`])).version;
      run(["git", "fetch", "-q", "--depth", "1", process.env.PB_PUBLIC_REPO || publicRepoFor(run(["git", "remote", "get-url", "origin"])), "main"]);
      const message = run(["git", "log", "-1", "--format=%B", "FETCH_HEAD"]);
      const version = JSON.parse(run(["git", "show", "FETCH_HEAD:package.json"])).version;
      fail.push(...publicVerdict({ message, version }, { sha: mainSha, version: mainVersion }));
    } catch (e) { fail.push(`the public repo could not be read: ${(e as Error).message}`); }
  }
  for (const f of fail) console.log(`✗ ${f}`);
  console.log(fail.length ? "OUT OF SYNC" : `IN SYNC (newest tag ${latestTag(tags) ?? "none"})`);
  return fail.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
