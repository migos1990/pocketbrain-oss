// SPDX-License-Identifier: AGPL-3.0-only
// Keeping the public repo and pocketbrain.dev in step (scripts/public-sync.ts, docs/release.md
// "The public repo and the site"): the public repo carries every main commit's export, and the
// site names only a tagged version, the newest one.
import { test, expect } from "bun:test";
import { latestTag, siteVersion, siteVerdict, publicVerdict, publicMessage, sourceOf } from "../scripts/public-sync";

test("the newest tag is the highest vX.Y.Z, not the last listed", () => {
  expect(latestTag(["v0.2.0", "v0.10.0", "v0.9.1", "release-1", "v1.0.0-rc1"])).toBe("v0.10.0");
  expect(latestTag([])).toBeUndefined();
});

test("the site names its version in one marked place", () => {
  expect(siteVersion('<p>Version <span data-pb-version="0.2.0">0.2.0</span></p>')).toBe("0.2.0");
  expect(siteVersion("<p>no version</p>")).toBeUndefined();
});

test("the site may name only a tagged version, and must name the newest", () => {
  const tags = ["v0.1.0", "v0.2.0"];
  expect(siteVerdict("0.2.0", tags)).toEqual([]);
  expect(siteVerdict("0.2.1", tags)).toEqual(["the site names 0.2.1, which is not a tag (newest tag v0.2.0)"]);
  expect(siteVerdict("0.1.0", tags)).toEqual(["the site names 0.1.0; the newest tag is v0.2.0: refresh the site"]);
  expect(siteVerdict(undefined, tags)).toEqual(["the site names no version (data-pb-version)"]);
});

test("the public repo's last commit names the private commit it was exported from, and must be main's tip", () => {
  const msg = publicMessage("0123456789abcdef0123456789abcdef01234567", "0.2.0");
  expect(msg).toContain("pocketBrain 0.2.0");
  expect(sourceOf(msg)).toBe("0123456789abcdef0123456789abcdef01234567");
  expect(sourceOf("pocketBrain 0.1.0: first public release (prototype)")).toBeUndefined();
  const main = "0123456789abcdef0123456789abcdef01234567";
  expect(publicVerdict({ message: msg, version: "0.2.0" }, { sha: main, version: "0.2.0" })).toEqual([]);
  expect(publicVerdict({ message: msg, version: "0.2.0" }, { sha: "f".repeat(40), version: "0.2.0" }))
    .toEqual([`the public repo holds main ${main.slice(0, 8)}; main is at ffffffff`]);
  expect(publicVerdict({ message: "pocketBrain 0.1.0: first public release (prototype)", version: "0.1.0" }, { sha: main, version: "0.2.0" }))
    .toEqual(["the public repo's last commit names no source commit", "the public repo says 0.1.0; main says 0.2.0"]);
});

test("the public commit message carries no private commit subject, only the version and the sha", () => {
  const msg = publicMessage("a".repeat(40), "0.2.0");
  expect(msg.split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
});


test("a secret-shaped string in the export stops the push unless the private history already knows that rule in that file", async () => {
  const { unexpectedLeaks } = await import("../scripts/public-sync");
  const ignore = "# fixtures\nabc123:test/door.test.ts:generic-api-key:16\n";
  expect(unexpectedLeaks([{ File: "test/door.test.ts", RuleID: "generic-api-key", StartLine: 20 }], ignore)).toEqual([]);
  expect(unexpectedLeaks([{ File: "src/hub.ts", RuleID: "generic-api-key", StartLine: 3 }], ignore)).toEqual(["src/hub.ts:generic-api-key:3"]);
  expect(unexpectedLeaks([{ File: "test/door.test.ts", RuleID: "private-key", StartLine: 16 }], ignore)).toEqual(["test/door.test.ts:private-key:16"]);
});

test("the public repo is pocketbrain-oss beside origin, so no tracked file names the owner", async () => {
  const { publicRepoFor } = await import("../scripts/public-sync");
  expect(publicRepoFor("https://github.com/someone/pocketbrain")).toBe("https://github.com/someone/pocketbrain-oss");
  expect(publicRepoFor("git@git.example:someone/pocketbrain.git")).toBe("git@git.example:someone/pocketbrain-oss");
});
