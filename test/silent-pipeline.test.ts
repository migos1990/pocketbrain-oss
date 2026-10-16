// SPDX-License-Identifier: AGPL-3.0-only
// Silent sources (backlog 201, the postmortem law): a pull that quietly stops looks exactly like a
// quiet week, so once the owner gave the consent line, a listed source that made no proposal and
// re-confirmed nothing for 72 hours is a failing probe check and a named line in the digest.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { jobChecks } from "../src/probe";
import { silentSources, fillLine } from "../src/fill";
import { digest } from "../src/digest";

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function brain(consent = true) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({
    ...(consent ? { consent: "2026-10-10 mail, calendar and Granola into facts with refs" } : {}),
    sources: {
      "gmail-personal": { kind: "gmail", account: "personal", where: ["INBOX"] },
      notes: { kind: "granola" },
      chat: { kind: "discord", where: ["123"] },
    },
  }));
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  const run = (source: string, at: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(join(root, "log", "sources", "runs.jsonl"), JSON.stringify({ at, source, fetched: 3, stored: [], skipped: 0, due: [], ...extra }) + "\n");
  run("gmail-personal", hoursAgo(120));
  run("gmail-personal", hoursAgo(96), { proposals: 2 }); // the last time it produced anything
  run("gmail-personal", hoursAgo(1));                     // still running, producing nothing
  run("notes", hoursAgo(110));
  run("chat", hoursAgo(20));                              // new: watched only after 72h
  // A Granola fact proposed yesterday, through the capture pipeline.
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "p1.yaml"), YAML.stringify({ proposed: "2026-10-19", by: "hub", capture: "capture/c1.md", request: { sources: ["granola:abc@1"] } }));
  return root;
}

test("a source that stopped producing for 72h is named; a busy one and a new one aren't", () => {
  const root = brain();
  expect(silentSources(root, NOW)).toEqual({ watched: ["gmail-personal", "notes"], silent: [{ source: "gmail-personal", hours: 72, last: "2026-10-16" }] });
  const check = jobChecks(root, NOW).find((c) => c.name === "fill")!;
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("gmail-personal for 72h (last 2026-10-16)");
  expect(check.detail).not.toContain("notes");
  expect(check.detail).not.toContain("chat");
});

test("a re-confirmed fact counts as the source working", () => {
  const root = brain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "writes.jsonl"), JSON.stringify({ at: hoursAgo(5), agent: "hub", kind: "source-confirm", key: "people/jane-roy#role", outcome: "committed", source: "gmail:personal/m42" }) + "\n");
  expect(silentSources(root, NOW)!.silent).toEqual([]);
  expect(jobChecks(root, NOW).find((c) => c.name === "fill")).toMatchObject({ ok: true, detail: "2 source(s) producing" });
});

test("a channel quiet by nature can wait longer, or not be watched at all", () => {
  const root = brain();
  const f = join(root, "rules", "sources.yaml");
  const y = YAML.parse(readFileSync(f, "utf8"));
  y.sources["gmail-personal"].silent_after_hours = 168;
  y.sources.notes.silent_after_hours = 0;
  writeFileSync(f, YAML.stringify(y));
  expect(silentSources(root, NOW)).toEqual({ watched: [], silent: [] }); // a week: its first pass (5 days ago) is still in the wait
});

test("without the consent line nothing is watched: live sources aren't read, so silence is expected", () => {
  const root = brain(false);
  expect(silentSources(root, NOW)).toBeUndefined();
  expect(jobChecks(root, NOW).find((c) => c.name === "fill")).toBeUndefined();
  expect(jobChecks(makeBrain(), NOW).find((c) => c.name === "fill")).toBeUndefined();
});

test("the digest's fill line gives the week against the target and names the silent source", () => {
  const root = brain();
  process.env.PB_TODAY = "2026-10-20";
  const line = fillLine(root, NOW)!;
  expect(line).toBe("- Filling: 1 proposed in 7 days (target 50), nothing decided yet, 0 re-confirmed; silent: gmail-personal (72h)");
  expect(fillLine(makeBrain(), NOW)).toBeUndefined();
  process.env.PB_TODAY = "2026-10-20"; // makeBrain resets it
  // The digest runs on the real clock: the fixture's runs are long past, so every watched source is silent there.
  expect(digest(root).text).toContain("- Filling: 1 proposed in 7 days (target 50)");
});
