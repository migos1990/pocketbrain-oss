// SPDX-License-Identifier: AGPL-3.0-only
// Red team 2026-10-15 (capture), the capture side: secrets in a subject or From line (G38), the
// `## Extracted` summary copying an item into git (G39), a malformed candidate from the model
// (G42) and one capture flooding the inbox (G44). Fake model and fixtures only; secret-shaped
// strings are built at run time so the repo never holds one whole.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { makeModel, type ModelRequest } from "../src/model";
import { capture, checkCandidate, extractPending, readCapture } from "../src/capture";
import { pullSource } from "../src/pull";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
const fake = (facts: (prompt: string) => unknown[]) => makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: facts(r.prompt) }) });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const proposals = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.includes("-capture-")) : [];
const readP = (root: string, f: string) => YAML.parse(readFileSync(join(root, "inbox", f), "utf8"));
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const PW = ["Hunter2", "Blue"].join("-");
function sources(root: string, srcs: Record<string, unknown>, files: Record<string, unknown>) {
  for (const [f, v] of Object.entries(files)) writeFileSync(join(root, f), JSON.stringify(v));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: srcs }));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
}
const disc = (id: number, content: string) => ({ id: String(id), channel_id: "111", channel_name: "#dev", type: 0, content, timestamp: `2026-10-07T10:${String(id % 60).padStart(2, "0")}:00Z`, author: { username: "u" + id } });

// ---------- G38: subject and From ----------

test("G38: a secret in a capture's subject or From line is removed before it is stored or committed", async () => {
  const root = makeBrain();
  const r = await capture(root, { kind: "email", text: "Jane Roy is now the course coordinator for Course B.", subject: `wifi password: ${PW} card ${CARD}`, from: `"pin: 4821" <owner@example.com>` }, undefined, { via: "drop" });
  expect(r.file).toMatch(/^inbox\/captures\//);
  const raw = readFileSync(join(root, r.file), "utf8");
  expect(raw).not.toContain(PW);
  expect(raw).not.toContain(CARD);
  expect(raw).not.toContain("4821");
  expect(raw).toContain("owner@example.com");
  expect(r.removed.length).toBeGreaterThanOrEqual(3);
  expect(readCapture(root, r.file).fm.removed).toEqual(r.removed);
  const hist = sh(root, "git", "log", "-p", "--format=");
  expect(hist).not.toContain(PW);
  expect(hist).not.toContain(CARD);
});

test("G38: a pulled item's subject (an invite title) is not kept in the capture record", async () => {
  const root = makeBrain();
  sources(root, { cal: { kind: "gcal", fixture: "c.json" } }, { "c.json": [{ id: "evt1", etag: '"e1"', summary: "Joint account PIN: 4821 reminder from bank", start: { dateTime: "2026-10-20T10:00:00Z" }, description: "Please book the exam room B-201 for Course A.", updated: "2026-10-07T00:00:00Z", calendar: "primary" }] });
  const r = await pullSource(root, "cal", { model: fake(() => []) });
  expect(r.stored.length).toBe(1);
  const raw = readFileSync(join(root, r.stored[0]), "utf8");
  expect(raw).not.toContain("4821");
  expect(raw).not.toMatch(/^subject:/m);
  expect(sh(root, "git", "log", "-p", "--format=", "--", "inbox")).not.toContain("4821");
});

// ---------- G39: the Extracted summary ----------

test("G39: dropped candidates are listed by status and attribute, never their values", async () => {
  const root = makeBrain();
  const m = fake(() => [
    { entity: "Jane Roy", type: "person", attribute: "role", value: "zebra quartz marmalade", quote: "Jane Roy" },
    { entity: "x", type: "note", attribute: "text", value: "Jane Roy is now the course coordinator", quote: "Jane Roy is now the course coordinator" },
  ]);
  const r = await capture(root, { kind: "text", text: "Jane Roy is now the course coordinator for Course B." }, m, { via: "cli" });
  const raw = readFileSync(join(root, r.file), "utf8");
  const summary = raw.split("## Extracted")[1];
  expect(summary).toContain("ungrounded");
  expect(summary).toContain("unsupported");
  expect(summary).not.toContain("zebra");
  expect(summary).not.toContain("course coordinator");
});

test("G39: a pulled item's capture record holds no value text beyond what became a proposal", async () => {
  const root = makeBrain();
  const desc = "Meeting with the advisor about the mortgage renewal and the private family matters we discussed, including Dana's diagnosis and the divorce timeline. Please book the exam room B-201 for Course A.";
  sources(root, { cal: { kind: "gcal", fixture: "c.json" } }, { "c.json": [{ id: "evt1", etag: '"e1"', summary: "Advisor", start: { dateTime: "2026-10-20T10:00:00Z" }, description: desc, updated: "2026-10-07T00:00:00Z", calendar: "primary" }] });
  const m = fake((p) => [
    ...(textOf(p).match(/[\s\S]{1,80}/g) ?? []).map((s) => ({ entity: "x", type: "note", attribute: "text", value: s, quote: s })),
    { entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "book the exam room B-201" },
    { entity: "Course A", type: "project", attribute: "next_step", value: "Grade the midterm", quote: "Course A" },
  ]);
  const r = await pullSource(root, "cal", { model: m });
  expect(r.proposals).toBe(1);
  const raw = readFileSync(join(root, r.stored[0]), "utf8");
  for (const w of ["diagnosis", "divorce", "mortgage", "Grade the midterm"]) expect(raw).not.toContain(w);
  expect(raw).toContain("unsupported");
  expect(raw).toContain("Book the exam room B-201");
});

// ---------- G42: malformed candidates ----------

test("G42: checkCandidate treats a non-string quote, entity, value, type or attribute as ungrounded and never throws", () => {
  const root = makeBrain();
  const notes = loadBrain(root), rules = loadRules(root);
  const text = "Jane Roy is the course coordinator now";
  const good = { entity: "Jane Roy", type: "person", attribute: "role", value: "Course coordinator", quote: "Jane Roy is the course coordinator" };
  for (const bad of [{ quote: 42 }, { entity: 42 }, { entity: { a: 1 } }, { value: ["x"] }, { type: null }, { attribute: 7 }, { as_of: 20261001 }]) {
    const c = { ...good, ...bad } as never;
    let st = "";
    expect(() => { st = checkCandidate(c, text, notes, rules).status; }).not.toThrow();
    if (!("as_of" in bad)) expect(st).toBe("ungrounded");
  }
  for (const bad of [null, 42, "a string", []]) expect(checkCandidate(bad as never, text, notes, rules).status).toBe("ungrounded");
});

test("G42: one malformed candidate doesn't stop the others, and the capture isn't left pending", async () => {
  const root = makeBrain();
  const m = fake(() => [
    { entity: 42, type: "project", attribute: "next_step", value: "x", quote: 42 },
    { entity: "Course A", type: { t: 1 }, attribute: "next_step", value: "x", quote: "book" },
    { entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "book the exam room B-201", as_of: 7 },
  ]);
  const r = await capture(root, { kind: "text", text: "Please book the exam room B-201 for Course A." }, undefined, { agent: "steward", via: "agent" });
  const out = await extractPending(root, m);
  expect(out.map((o) => o.error)).toEqual([undefined]);
  expect(readCapture(root, r.file).status).toBe("extracted");
  expect(proposals(root).length).toBe(1);
  expect(readP(root, proposals(root)[0]).request.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

// ---------- G44: proposal cap and dedupe ----------

const spam = (n: number) => Array.from({ length: n }, (_, i) => `Person${i} Spam is a sales rep.`).join(" ");
const spamFacts = (p: string) => [...textOf(p).matchAll(/(Person\d+ Spam) is a sales rep\./g)].map((x) => ({ entity: x[1], type: "person", attribute: "role", value: "sales rep", quote: x[0] }));

test("G44: one capture makes at most capture.max_proposals proposals (default 10); the rest are listed as over the cap", async () => {
  const root = makeBrain();
  const r = await capture(root, { kind: "text", text: spam(15) }, fake(spamFacts), { via: "cli" });
  expect(proposals(root).length).toBe(10);
  expect(r.items.filter((i) => i.status === "over-cap").length).toBe(5);
  expect(r.items.filter((i) => i.status === "over-cap").every((i) => !i.proposal)).toBe(true);
  expect(readFileSync(join(root, r.file), "utf8")).toContain("over the cap");

  const root2 = makeBrain();
  const p = join(root2, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8") + "capture:\n  max_proposals: 3\n");
  sh(root2, "git", "commit", "-qam", "owner: cap");
  await capture(root2, { kind: "text", text: spam(6) }, fake(spamFacts), { via: "cli" });
  expect(proposals(root2).length).toBe(3);
});

test("G44: the same fact from several pulled messages is one proposal citing each message", async () => {
  const root = makeBrain();
  const msgs = ["one", "two", "three"].map((w, i) => disc(900 + i, `Heads up: Jane Roy is now the dean of studies, note ${w}`));
  sources(root, { disc: { kind: "discord", where: ["#dev"], fixture: "d.json" } }, { "d.json": msgs });
  const m = fake((p) => /dean of studies/.test(textOf(p)) ? [{ entity: "Jane Roy", type: "person", attribute: "role", value: "Dean of studies", quote: "Jane Roy is now the dean of studies" }] : []);
  await pullSource(root, "disc", { model: m });
  const ps = proposals(root);
  expect(ps.length).toBe(1);
  expect(readP(root, ps[0]).request.sources).toEqual(["discord:111/900@1", "discord:111/901@1", "discord:111/902@1"]);
});

test("G44: two captures of the same fact in other words are one proposal", async () => {
  const root = makeBrain();
  const m = fake(() => [{ entity: "Jane Roy", type: "person", attribute: "role", value: "dean of studies", quote: "Jane Roy is now the dean of studies" }]);
  await capture(root, { kind: "text", text: "Jane Roy is now the dean of studies" }, m, { via: "cli" });
  await capture(root, { kind: "text", text: "FYI Jane Roy is now the dean of studies, 2" }, m, { via: "cli" });
  expect(proposals(root).length).toBe(1);
});

// ---------- G92: a paragraph as a fact value ----------

const PARA = "Marc wrote: honestly the board is furious with Dana after the audit, she hid the overspend from everyone for months and we are quietly looking for her replacement before the spring review so please keep this between us and book exam room B-201 before Friday";

test("G92: a value over 200 characters is unsupported (too long to be a fact), even when every word is in the text", () => {
  const root = makeBrain();
  const it = checkCandidate({ entity: "Course A", type: "project", attribute: "next_step", value: PARA, quote: PARA }, PARA, loadBrain(root), loadRules(root));
  expect(it.status).toBe("unsupported");
  expect(it.why).toContain("too long to be a fact");
  const short = checkCandidate({ entity: "Course A", type: "project", attribute: "next_step", value: "Book exam room B-201", quote: "book exam room B-201" }, PARA, loadBrain(root), loadRules(root));
  expect(short.status).not.toBe("unsupported");
});

test("G92: a pulled paragraph returned as a value makes no proposal and isn't committed", async () => {
  const root = makeBrain();
  sources(root, { "slack-work": { kind: "slack", where: ["#course-a"], area: "work", fixture: "slack.json" } }, { "slack.json": [{ team: "T1", channel: "C9", channel_name: "#course-a", ts: "1760300000.000100", user: "U1", text: PARA }] });
  const r = await pullSource(root, "slack-work", { model: fake(() => [{ entity: "Course A", type: "project", attribute: "next_step", value: PARA, quote: PARA }]) });
  expect(r.proposals).toBe(0);
  expect(proposals(root).length).toBe(0);
  expect(sh(root, "git", "log", "-p", "--format=", "--", "inbox")).not.toContain("quietly looking for her replacement");
  expect(readFileSync(join(root, r.stored[0]), "utf8")).toContain("too long to be a fact");
});
