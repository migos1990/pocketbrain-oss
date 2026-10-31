// SPDX-License-Identifier: AGPL-3.0-only
// Releases (scripts/release.ts): version bumps, cutting the changelog, the tag check CI runs, and
// a whole cut in a throwaway repo (branch, merge into main, annotated tag, nothing pushed).
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextVersion, cutChangelog, pending, notesFor, verifyTag, due, releaseNotes } from "../scripts/release";

const LOG = `# Changelog

Intro.

## [Unreleased]

### Fixed

- The digest no longer repeats.

## [0.2.0] - 2026-10-01

### Added

- Spend caps.
`;

test("versions bump by semver", () => {
  expect(nextVersion("0.2.0", "patch")).toBe("0.2.1");
  expect(nextVersion("0.2.7", "minor")).toBe("0.3.0");
  expect(nextVersion("0.2.7", "major")).toBe("1.0.0");
  expect(() => nextVersion("0.2", "patch")).toThrow();
});

test("a cut dates the Unreleased entries under the new version and leaves Unreleased empty", () => {
  const c = cutChangelog(LOG, { current: "0.2.0", bump: "patch", date: "2026-10-15" });
  expect(c.version).toBe("0.2.1");
  expect(c.notes).toBe("### Fixed\n\n- The digest no longer repeats.");
  expect(c.text).toContain("## [Unreleased]\n\n## [0.2.1] - 2026-10-15\n\n### Fixed\n\n- The digest no longer repeats.\n\n## [0.2.0] - 2026-10-01");
  expect(pending(c.text).body).toBe("");
  expect(notesFor(c.text, "v0.2.0")).toBe("### Added\n\n- Spend caps.");
});

test("a prepared '- unreleased' section keeps its version and takes the Unreleased entries", () => {
  const prepared = "# Changelog\n\n## [Unreleased]\n\n- Late fix.\n\n## [0.1.0] - unreleased\n\nThe first version.\n";
  const c = cutChangelog(prepared, { current: "0.1.0", bump: "minor", date: "2026-10-15" });
  expect(c.version).toBe("0.1.0");
  expect(c.text).toBe("# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-15\n\n- Late fix.\n\nThe first version.\n");
});

test("nothing to release is refused", () => {
  expect(() => cutChangelog("# C\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-01\n\n- x\n", { current: "0.2.0", bump: "patch", date: "2026-10-15" })).toThrow(/nothing to release/);
});

test("CI's tag check: the tag, package.json and a dated section must agree", () => {
  const cut = cutChangelog(LOG, { current: "0.2.0", bump: "patch", date: "2026-10-15" }).text;
  expect(verifyTag("v0.2.1", "0.2.1", cut)).toEqual([]);
  expect(verifyTag("v0.2.1", "0.2.0", cut)).toEqual(["package.json says 0.2.0, the tag says 0.2.1"]);
  expect(verifyTag("v0.3.0", "0.3.0", cut)).toEqual(["CHANGELOG.md has no ## [0.3.0] section"]);
  expect(verifyTag("v0.1.0", "0.1.0", "## [Unreleased]\n\n## [0.1.0] - unreleased\n\n- x\n")).toEqual(["CHANGELOG.md's 0.1.0 section is not dated (unreleased)"]);
  expect(verifyTag("release-1", "0.1.0", cut)[0]).toBe("tag release-1 is not vX.Y.Z");
});

test("CI tags main itself: a dated, untagged package.json version is due, anything else isn't", () => {
  const cut = cutChangelog(LOG, { current: "0.2.0", bump: "patch", date: "2026-10-15" }).text;
  expect(due("0.2.1", cut, ["v0.2.0"])).toBe("v0.2.1");
  expect(due("0.2.1", cut, ["v0.2.0", "v0.2.1"])).toBeUndefined();
  expect(due("0.2.0", LOG, ["v0.2.0"])).toBeUndefined();
  expect(due("0.1.0", "## [Unreleased]\n\n## [0.1.0] - unreleased\n\n- x\n", [])).toBeUndefined();
});

test("a whole cut in a throwaway repo: release branch merged into main, annotated tag, nothing pushed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-release-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", PB_TODAY: "2026-10-15" };
  const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { cwd: dir, env, stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  sh(["git", "init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "CHANGELOG.md"), LOG);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.2.0" }, null, 2) + "\n");
  writeFileSync(join(dir, "README.md"), "# x\n\n> **Status: early (0.2.0, see CHANGELOG.md).**\n");
  sh(["git", "add", "-A"]); sh(["git", "commit", "-q", "-m", "start"]);
  const script = join(import.meta.dir, "..", "scripts", "release.ts");

  expect(sh(["bun", script, "check", "minor", "--no-run"]).out).toContain("RELEASABLE as v0.3.0");
  const cut = sh(["bun", script, "cut", "minor", "--no-run"]);
  expect(cut.code).toBe(0);
  expect(cut.out).toContain("tagged v0.3.0 on main");
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.3.0");
  expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Status: early (0.3.0,");
  expect(sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out.trim()).toBe("main");
  expect(sh(["git", "cat-file", "-t", "v0.3.0"]).out.trim()).toBe("tag");
  expect(sh(["git", "log", "-1", "--format=%s"]).out.trim()).toBe("Merge claude/release-0.3.0: release 0.3.0");
  expect(sh(["bun", script, "verify-tag", "v0.3.0"]).code).toBe(0);
  expect(sh(["bun", script, "notes", "v0.3.0"]).out.trim()).toBe("### Fixed\n\n- The digest no longer repeats.");
  // Pushed without its tag (a cloud session can't push tags): CI sees the release is due.
  expect(sh(["bun", script, "due"]).out.trim()).toBe("");
  sh(["git", "tag", "-d", "v0.3.0"]);
  expect(sh(["bun", script, "due"]).out.trim()).toBe("v0.3.0");
  sh(["git", "tag", "-a", "v0.3.0", "-m", "again"]);
  // Unreleased is empty now, and the tag is taken: a second cut is refused.
  const again = sh(["bun", script, "check", "--no-run"]);
  expect(again.code).toBe(1);
  expect(again.out).toContain("nothing to release");
});

// Backlog 296: the notes a release tag and its GitHub release carry, built from the section.
const MESSY = `Intro line.

- A stray line merged in without a heading.

### Fixed

- First fix,
  over two lines.

### Added

- New thing.

### Before you update

- Run \`pocketbrain gardener setup\` once: rules/gardener.yaml is new.

### Fixed

- Second fix.

### Changed

- Reads are capped. What to do: nothing.
`;

test("release notes: owner steps first, then the usual groups, duplicates merged, strays kept", () => {
  expect(releaseNotes(MESSY)).toBe([
    "Intro line.",
    "### Before you update\n\n- Run `pocketbrain gardener setup` once: rules/gardener.yaml is new.",
    "### Changed\n\n- Reads are capped. What to do: nothing.",
    "### Added\n\n- New thing.",
    "### Fixed\n\n- First fix,\n  over two lines.\n- Second fix.",
    "### Other changes\n\n- A stray line merged in without a heading.",
  ].join("\n\n"));
  // Custom groups (the first version's) keep their order after the usual ones.
  expect(releaseNotes("### Running it\n\n- b\n\n### Security\n\n- a\n")).toBe("### Security\n\n- a\n\n### Running it\n\n- b");
  expect(notesFor(`## [Unreleased]\n\n## [0.3.0] - 2026-10-20\n\n${MESSY}`, "v0.3.0")).toBe(releaseNotes(MESSY));
});

test("a tag whose section has no entries fails CI's tag check; prose alone is not notes", () => {
  const empty = "## [Unreleased]\n\n## [0.3.0] - 2026-10-20\n\nNothing much.\n";
  expect(verifyTag("v0.3.0", "0.3.0", empty)).toEqual(["CHANGELOG.md's 0.3.0 section has no entries (- lines), so the release would have no notes"]);
  expect(verifyTag("v0.3.0", "0.3.0", `## [Unreleased]\n\n## [0.3.0] - 2026-10-20\n\n${MESSY}`)).toEqual([]);
});

test("the cut's tag message is the grouped notes", () => {
  const c = cutChangelog(`# C\n\n## [Unreleased]\n\n${MESSY}\n## [0.2.0] - 2026-10-01\n\n- x\n`, { current: "0.2.0", bump: "patch", date: "2026-10-20" });
  expect(c.notes).toBe(releaseNotes(MESSY));
});

test("the README's status line names the version being tagged, and a cut moves it", async () => {
  const { readmeVersion, stampReadme } = await import("../scripts/release");
  const readme = "# x\n\n> **Status: early (0.1.0, see [CHANGELOG.md](CHANGELOG.md)), used daily.**\n";
  expect(readmeVersion(readme)).toBe("0.1.0");
  expect(readmeVersion("# no status line\n")).toBeUndefined();
  const cut = cutChangelog(LOG, { current: "0.2.0", bump: "patch", date: "2026-10-15" }).text;
  expect(verifyTag("v0.2.1", "0.2.1", cut, readme)).toEqual(["README.md's status line says 0.1.0, the tag says 0.2.1"]);
  expect(verifyTag("v0.2.1", "0.2.1", cut, "# none\n")).toEqual(["README.md has no \"Status: early (X.Y.Z\" line naming the version"]);
  const stamped = stampReadme(readme, "0.2.1");
  expect(readmeVersion(stamped)).toBe("0.2.1");
  expect(stamped.replace("0.2.1", "0.1.0")).toBe(readme);
  expect(verifyTag("v0.2.1", "0.2.1", cut, stamped)).toEqual([]);
});
