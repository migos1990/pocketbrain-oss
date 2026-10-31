// SPDX-License-Identifier: AGPL-3.0-only
// What the Gardener couldn't do (docs/gardener.md): a night with no source to check against, no
// check in a week though facts wait, or no gardener.yaml for a managed Gardener is said in the
// week report, and in the digest once, then weekly while it holds.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { blindSpots, blindSpotNews } from "../src/blindspots";
import { week } from "../src/measure";
import { digest } from "../src/digest";

afterEach(() => { process.env.PB_TODAY = "2026-10-08"; });

const withSources = (root: string) => {
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["Label_school"], fixture: "mail.json" } } }));
  writeFileSync(join(root, "mail.json"), "[]");
  // Course A's next step cites a mail and is past its shelf life on 2026-10-30: a recheck waits.
  const f = join(root, "projects/course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace('sources: ["gmail:f000000000000003"]', 'sources: ["gmail:a1b2c3d4e5f60718"]'));
};
const policy = (root: string, edit: (s: string) => string) => { const f = join(root, "rules/policy.yaml"); writeFileSync(f, edit(readFileSync(f, "utf8"))); };

test("no source connected: the Gardener says it can't check facts, and how to fix it", () => {
  const root = makeBrain();
  const b = blindSpots(root);
  expect(b.map((x) => x.kind)).toEqual(["no-sources"]);
  expect(b[0].fix).toContain("pocketbrain sources connect");
  expect(week(root, "2026-10-08").text).toContain("What the Gardener couldn't do:");
});

test("the digest tells it once, then again a week later while it still holds", () => {
  const root = makeBrain();
  expect(digest(root).text).toContain("**Gardener blind spot**");
  expect(digest(root).text).not.toContain("**Gardener blind spot**");
  expect(blindSpotNews(root, "2026-10-14")).toEqual([]);
  expect(blindSpotNews(root, "2026-10-15")).toHaveLength(1);
});

test("sources but no check in a week while facts wait: said; one check this week: quiet", () => {
  const root = makeBrain();
  withSources(root);
  process.env.PB_TODAY = "2026-10-30";
  expect(blindSpots(root, "2026-10-30").map((x) => x.kind)).toEqual(["no-checks"]);
  mkdirSync(join(root, "log/sources"), { recursive: true });
  // A night of reads that all failed (a lapsed sign-in) isn't a check.
  appendFileSync(join(root, "log/sources/verify.jsonl"), JSON.stringify({ at: "2026-10-28T08:00:00Z", agent: "hub", ref: "gmail:a1b2c3d4e5f60718", result: "unreachable" }) + "\n");
  expect(blindSpots(root, "2026-10-30").map((x) => x.kind)).toEqual(["no-checks"]);
  appendFileSync(join(root, "log/sources/verify.jsonl"), JSON.stringify({ at: "2026-10-27T08:00:00Z", agent: "hub", ref: "gmail:a1b2c3d4e5f60718", result: "match" }) + "\n");
  expect(blindSpots(root, "2026-10-30")).toEqual([]);
  // A check older than a week doesn't count.
  process.env.PB_TODAY = "2026-11-05";
  expect(blindSpots(root, "2026-11-05").map((x) => x.kind)).toEqual(["no-checks"]);
});

test("a managed Gardener with no gardener.yaml: in the week report, not repeated in the digest", () => {
  const root = makeBrain();
  withSources(root);
  policy(root, (s) => `night: managed\n${s}`);
  expect(blindSpots(root).map((x) => x.kind)).toEqual(["no-config"]);
  expect(week(root, "2026-10-08").text).toContain("rules/gardener.yaml is missing");
  expect(blindSpotNews(root)).toEqual([]);
  writeFileSync(join(root, "rules/gardener.yaml"), "ant_profile: pocketbrain\n");
  expect(blindSpots(root)).toEqual([]);
});

test("no Gardener, or a paused one: nothing to say", () => {
  const root = makeBrain();
  policy(root, (s) => s.replace("gardener: { tier: trial,", "gardener: { status: paused, tier: trial,"));
  expect(blindSpots(root)).toEqual([]);
  policy(root, (s) => s.replace(/^  gardener:.*\n/m, ""));
  expect(blindSpots(root)).toEqual([]);
});
