// SPDX-License-Identifier: AGPL-3.0-only
// The gardener learns the owner's answers (docs/gardener.md): last_run lists its proposals the owner
// decided in the last 30 days, a proposal the owner rejected can't come back for 30 days, and one
// already waiting in the inbox isn't filed again on a later night. Both refusals are code.
import { test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { decideProposal } from "../src/write";
import { useCells } from "../src/cell";

const SRC = { as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };
afterEach(() => { delete process.env.PB_NOW; process.env.PB_TODAY = "2026-10-08"; useCells(false); });
async function call(root: string, token: string, method: string, path: string, body?: unknown) {
  const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, json: (await res.json()) as any };
}
const night = (day: string) => { process.env.PB_TODAY = day; process.env.PB_NOW = `${day}T08:30:00Z`; }; // in the nightly window (04:30 EDT, 03:30 EST)
const inbox = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"));
const PROPOSAL = { id: "projects/course-a", attribute: "next_step", value: "Publish grades", ...SRC };

test("a proposal the owner rejected is refused for 30 days; a different value still goes through", async () => {
  const root = makeBrain();
  night("2026-10-08");
  const tok = issueToken(root, "gardener");
  await call(root, tok, "POST", "/v1/gardener/upkeep");
  expect((await call(root, tok, "POST", "/v1/remember", PROPOSAL)).json.outcome).toBe("inbox");
  expect(decideProposal(root, inbox(root)[0], "reject").outcome).toBe("noop");
  night("2026-10-09");
  const again = await call(root, tok, "POST", "/v1/remember", PROPOSAL);
  expect(again.json.outcome).toBe("refused");
  expect(again.json.message).toContain("rejected on 2026-10-08");
  expect((await call(root, tok, "POST", "/v1/remember", { ...PROPOSAL, value: "Publish grades on Monday" })).json.outcome).toBe("inbox");
  decideProposal(root, inbox(root)[0], "accept");
  night("2026-11-08");
  expect((await call(root, tok, "POST", "/v1/remember", PROPOSAL)).json.outcome).toBe("inbox");
});

test("a proposal already waiting in the inbox isn't filed again on a later night", async () => {
  const root = makeBrain();
  night("2026-10-08");
  const tok = issueToken(root, "gardener");
  expect((await call(root, tok, "POST", "/v1/remember", PROPOSAL)).json.outcome).toBe("inbox");
  night("2026-10-09");
  const r = await call(root, tok, "POST", "/v1/remember", PROPOSAL);
  expect(r.json.outcome).toBe("noop");
  expect(r.json.message).toContain("already waiting");
  expect(inbox(root).length).toBe(1);
});

// Mac audit 2026-10-16: the live gardener re-proposed the same notes night after night with new
// wording, so the exact-change check never fired. One waiting proposal per fact (or note) at a time.
test("while one proposal on a fact waits, another value for that fact isn't filed; other facts still are", async () => {
  const root = makeBrain();
  night("2026-10-08");
  const tok = issueToken(root, "gardener");
  expect((await call(root, tok, "POST", "/v1/remember", PROPOSAL)).json.outcome).toBe("inbox");
  night("2026-10-09");
  const r = await call(root, tok, "POST", "/v1/remember", { ...PROPOSAL, value: "Publish the grades this week" });
  expect(r.json.outcome).toBe("noop");
  expect(r.json.message).toContain("already waiting");
  expect((await call(root, tok, "POST", "/v1/remember", { ...PROPOSAL, attribute: "room", value: "B-201" })).json.outcome).toBe("inbox");
  expect(inbox(root).length).toBe(2);
  // Once the owner answers, a new value for that fact can be proposed again.
  decideProposal(root, inbox(root).sort()[0], "accept");
  expect((await call(root, tok, "POST", "/v1/remember", { ...PROPOSAL, value: "Publish the grades this week" })).json.outcome).toBe("inbox");
});

test("last_run lists the gardener's proposals the owner decided in the last 30 days", async () => {
  const root = makeBrain();
  night("2026-10-08");
  const tok = issueToken(root, "gardener");
  await call(root, tok, "POST", "/v1/remember", PROPOSAL);
  await call(root, tok, "POST", "/v1/remember", { ...PROPOSAL, attribute: "room", value: "Book room B-201" });
  const [a, b] = inbox(root);
  decideProposal(root, a, "accept");
  decideProposal(root, b, "reject");
  await call(root, tok, "POST", "/v1/gardener/upkeep");
  const last = (await call(root, tok, "GET", "/v1/gardener/last")).json;
  expect(last.decided.map((d: any) => d.decision).sort()).toEqual(["accept", "reject"]);
  expect(last.decided.map((d: any) => d.key).sort()).toEqual(["projects/course-a#next_step", "projects/course-a#room"]);
  expect(last.decided[0]).toMatchObject({ decided: "2026-10-08" });
  expect(last.decided.find((d: any) => d.decision === "reject").value).toBeDefined();
  expect(last.waiting).toBe(0);
});

test("another agent's re-proposal of a value the owner rejected from the gardener is not affected", async () => {
  const root = makeBrain();
  night("2026-10-08");
  await call(root, issueToken(root, "gardener"), "POST", "/v1/remember", PROPOSAL);
  decideProposal(root, inbox(root)[0], "reject");
  expect((await call(root, issueToken(root, "helper"), "POST", "/v1/remember", PROPOSAL)).json.outcome).not.toBe("refused");
});

// Slice audit (G109): a decision on a fact the gardener can no longer see doesn't come back.
test("last_run leaves out decisions on facts now hidden from the gardener", async () => {
  // With cells on (as the hub serves), the cell has already dropped the hidden fact.
  for (const cells of [false, true]) for (const how of ["secret", "share_with", "exclude"] as const) {
    const root = makeBrain();
    useCells(cells);
    night("2026-10-08");
    const tok = issueToken(root, "gardener");
    await call(root, tok, "POST", "/v1/remember", { ...PROPOSAL, value: "Book room B-201" });
    decideProposal(root, inbox(root)[0], "accept");
    const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
    const f = n.fm.facts!.next_step as FactRecord;
    if (how === "secret") f.sensitivity = "secret";
    if (how === "share_with") f.share_with = ["steward"];
    saveNote(root, n);
    if (how === "exclude") {
      const p = join(root, "rules", "policy.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace("slices: [all], max_proposals_per_day: 13", 'slices: [all], exclude: ["projects/course-a#next_step"], max_proposals_per_day: 13'));
    }
    const last = (await call(root, tok, "GET", "/v1/gardener/last")).json;
    expect(JSON.stringify(last)).not.toContain("B-201");
    expect(JSON.stringify(last)).not.toContain("next_step");
  }
});

test("last_run leaves out a decision on a note the gardener proposed, once that fact is hidden", async () => {
  // With cells on (as the hub serves), the cell has already dropped the hidden fact.
  for (const cells of [false, true]) for (const how of ["secret", "share_with", "exclude"] as const) {
    const root = makeBrain();
    useCells(cells);
    night("2026-10-08");
    const tok = issueToken(root, "gardener");
    await call(root, tok, "POST", "/v1/remember", { title: "Course Z", type: "project", area: "work", attribute: "next_step", value: "Zeta plan", ...SRC });
    decideProposal(root, inbox(root)[0], "accept");
    const n = loadBrain(root).find((x) => x.fm.title === "Course Z")!;
    const f = n.fm.facts!.next_step as FactRecord;
    if (how === "secret") f.sensitivity = "secret";
    if (how === "share_with") f.share_with = ["steward"];
    saveNote(root, n);
    if (how === "exclude") {
      const p = join(root, "rules", "policy.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace("slices: [all], max_proposals_per_day: 13", `slices: [all], exclude: ["${n.fm.id}#next_step"], max_proposals_per_day: 13`));
    }
    const last = JSON.stringify((await call(root, tok, "GET", "/v1/gardener/last")).json);
    expect(last).not.toContain("Zeta plan");
    expect(last).not.toContain("next_step");
  }
});

test("a title shared with a note hidden from the gardener drops the decision (no twin can vouch for it)", async () => {
  const root = makeBrain();
  night("2026-10-08");
  const tok = issueToken(root, "gardener");
  await call(root, tok, "POST", "/v1/remember", { title: "Course Z", type: "project", area: "work", attribute: "next_step", value: "Zeta plan", ...SRC });
  decideProposal(root, inbox(root)[0], "accept");
  const n = loadBrain(root).find((x) => x.fm.title === "Course Z")!;
  n.fm.sensitivity = "secret";
  saveNote(root, n);
  writeFileSync(join(root, "projects", "course-z-2.md"), readFileSync(join(root, n.path), "utf8").replace(`id: ${n.fm.id}`, "id: projects/course-z-2").replace("sensitivity: secret", "sensitivity: personal").replace("Zeta plan", "Other plan"));
  const last = JSON.stringify((await call(root, tok, "GET", "/v1/gardener/last")).json);
  expect(last).not.toContain("Zeta plan");
});
