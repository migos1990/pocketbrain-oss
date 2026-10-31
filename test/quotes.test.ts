// SPDX-License-Identifier: AGPL-3.0-only
// Facts, not copies (docs/sources-pull.md, src/quotes.ts): the words a pulled fact came from show on
// the owner's card while the proposal waits, and nowhere else. They are never in the proposal file,
// its decided copy, a commit, a log or the digest, and they are gone once the owner decides.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type ModelRequest } from "../src/model";
import { useCaptureModel, captureModel } from "../src/capture";
import { pullSource } from "../src/pull";
import { decideProposal } from "../src/write";
import { openItems } from "../src/textline/items";
import { digest } from "../src/digest";
import { getQuote, putQuote } from "../src/quotes";
import { instinctTransport, markOutbox, outbox } from "../src/textline/transport";
import { tick } from "../src/textline/poll";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { upkeep, undoRun } from "../src/upkeep";

const QUOTE = "Marc says the whole team must book the exam room B-201 before Friday";
beforeAll(() => useCaptureModel(() => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) =>
  JSON.stringify({ facts: /exam room B-201/.test(r.prompt) ? [{ entity: "Course A", type: "project", attribute: "next_step", value: "Book B-201", quote: QUOTE }] : [] }) })));
afterAll(() => useCaptureModel());

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString();
const slack = (ts: string, text: string) => ({ team: "T1", channel: "C9", channel_name: "#course-a", ts, user: "U1", text });

async function pulled(): Promise<{ root: string; file: string }> {
  const root = makeBrain();
  writeFileSync(join(root, "slack.json"), JSON.stringify([slack("1760300000.000100", `Hi all. ${QUOTE}. Thanks!`)]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { "slack-work": { kind: "slack", where: ["#course-a"], area: "work", fixture: "slack.json" } } }));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: sources");
  const r = await pullSource(root, "slack-work");
  expect(r.proposals).toBe(1);
  const file = readdirSync(join(root, "inbox")).find((f) => f.includes("-capture-"))!;
  return { root, file };
}

// Everything that stays: tracked and untracked files outside .git, and every commit's content.
function kept(root: string): string {
  // slack.json is the test's stand-in for the source itself, so it is left out.
  const files = sh(root, "git", "ls-files", "--others", "--cached", "--exclude-standard").split("\n").filter((f) => f && f !== "slack.json");
  return files.map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "")).join("\n") + sh(root, "git", "log", "-p", "--all", "--", ".", ":!slack.json");
}

test("while the proposal waits, the quote is on the owner's card and nowhere that stays", async () => {
  const { root, file } = await pulled();
  expect(getQuote(root, file)).toBe(QUOTE);
  expect(openItems(root).find((i) => i.ref === file)!.title).toContain(`("${QUOTE.slice(0, 40)}`);
  digest(root);
  expect(kept(root)).not.toContain("whole team must book");
});

for (const decision of ["accept", "reject"] as const) {
  test(`once the owner decides (${decision}), the quote is gone and no copy, commit or log holds it`, async () => {
    const { root, file } = await pulled();
    // Accepting a pulled proposal is refused on main today (gap G57: its source_type is
    // `document` with a source ref); the fix lives on another branch. Give it a type the write
    // path takes, so this test is about the quote, not G57.
    const f = join(root, "inbox", file);
    const y = YAML.parse(readFileSync(f, "utf8"));
    y.request.source_type = "import";
    writeFileSync(f, YAML.stringify(y));
    sh(root, "git", "commit", "-qam", "test: source type");
    const d = decideProposal(root, file, decision);
    expect(`${d.outcome}: ${d.message}`).not.toStartWith("refused");
    expect(getQuote(root, file)).toBeUndefined();
    expect(readFileSync(join(root, "inbox", "decided", file), "utf8")).not.toContain("whole team must book");
    expect(kept(root)).not.toContain("whole team must book");
  });
}

test("a decision the write path refuses leaves the proposal waiting, quote and all", async () => {
  const { root, file } = await pulled();
  const f = join(root, "inbox", file);
  const y = YAML.parse(readFileSync(f, "utf8"));
  y.request = { ...y.request, source_type: "import", attribute: "standing" }; // a reserved attribute: always refused
  writeFileSync(f, YAML.stringify(y));
  sh(root, "git", "commit", "-qam", "test: reserved");
  expect(decideProposal(root, file, "accept").outcome).toBe("refused");
  expect(getQuote(root, file)).toBe(QUOTE);
});

test("a text Instinct sent or that was replaced keeps no words in the outbox", async () => {
  const root = makeBrain();
  const t = instinctTransport(root);
  await t.send({ id: "t-1", text: `From slack: x ("${QUOTE}")`, at: "2026-10-08T12:00:00Z" });
  await t.send({ id: "t-2", text: `From slack: y ("${QUOTE}")`, at: "2026-10-08T12:00:00Z" });
  expect(outbox(root).every((m) => m.text.includes("whole team"))).toBe(true); // waiting: Instinct needs the words
  markOutbox(root, "t-1", "sent", "m1");
  markOutbox(root, "t-2", "superseded");
  expect(outbox(root).map((m) => [m.status, m.text])).toEqual([["sent", ""], ["superseded", ""]]);
});

test("deciding one proposal never sweeps the quote of another that is still waiting", async () => {
  const { root, file } = await pulled();
  const other = file.replace("-capture-", "-capture-b");
  writeFileSync(join(root, "inbox", other), readFileSync(join(root, "inbox", file), "utf8"));
  putQuote(root, other, "the other proposal's words");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "test: second proposal");
  expect(decideProposal(root, file, "reject").outcome).not.toBe("refused");
  expect(getQuote(root, file)).toBeUndefined();
  expect(getQuote(root, other)).toBe("the other proposal's words");
});

test("G95: a queued text stops being served, and loses its words, once nothing it asks about is open", async () => {
  const { root, file } = await pulled();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nbatch: { style: list, wait_minutes: 0 }\ntransport: { use: instinct }\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: escalation");
  await tick(root, { now: new Date("2026-10-08T18:00:00Z"), fetch: async () => new Response("{}") });
  expect(outbox(root).filter((m) => m.status === "queued" && m.text.includes("whole team")).length).toBe(1);
  expect(decideProposal(root, file, "reject").outcome).not.toBe("refused");
  const tok = issueToken(root, "steward");
  const r = await handle(root, new Request("http://pb/v1/owner/outbox", { headers: { authorization: `Bearer ${tok}` } }));
  expect(((await r.json()) as { texts: unknown[] }).texts).toEqual([]);
  expect(outbox(root).map((m) => [m.status, m.text])).toEqual([["superseded", ""]]);
});

test("G94: undo --run commits only what it reverts and the suppressions, never waiting texts or quotes", () => {
  const root = makeBrain();
  const p = join(root, "projects/course-b.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("created: 2026-10-01", "created: 2026-9-5"));
  sh(root, "git", "commit", "-qam", "louis: setup");
  const r = upkeep(root, { now: "2026-10-08" });
  mkdirSync(join(root, "textline", "outbox"), { recursive: true });
  writeFileSync(join(root, "textline", "outbox", "t-9.json"), JSON.stringify({ id: "t-9", text: `("${QUOTE}")`, status: "queued" }));
  writeFileSync(join(root, "stray.txt"), "not the owner's undo");
  expect(undoRun(root, r.run)).toContain("reverted");
  const files = sh(root, "git", "show", "--name-only", "--format=", "HEAD").trim().split("\n");
  expect(files).toContain("rules/suppressions.yaml");
  expect(files).not.toContain("textline/outbox/t-9.json");
  expect(files).not.toContain("stray.txt");
});
