// SPDX-License-Identifier: AGPL-3.0-only
// A Gardener proposal citing an email for a value that email doesn't say is refused before the
// write (G377, docs/gardener.md "What the hub checks"): the hub reads the cited item, as
// verify_source does, by the same word check. Fixture mail only.
import { test, expect, afterEach } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { SOURCE_SAYS_REFUSALS_PER_DAY } from "../src/core";

// 07:30Z on a Thursday is 03:30 in Toronto: inside the fixture gardener's nightly hours.
afterEach(() => { delete process.env.PB_NOW; });
const MAIL = [
  { id: "f000000000000001", labelIds: ["INBOX"], internalDate: "1791363600000", payload: { headers: [{ name: "Subject", value: "Jane Roy, new role" }] }, text: "Hi Robin, a quick update: since October 1 I'm Associate Dean at Northfield. Sam takes over as course coordinator. Jane" },
  { id: "f000000000000003", labelIds: ["INBOX"], internalDate: "1791363600000", payload: { headers: [{ name: "Subject", value: "Course A" }] }, text: "Reminder for Course A: grade the midterm by Oct 14." },
  { id: "f000000000000009", labelIds: ["INBOX"], internalDate: "1791363600000", payload: { headers: [{ name: "Subject", value: "Other" }] }, text: "The budget is now 5000 dollars." },
];
function setup() {
  const root = makeBrain();
  process.env.PB_NOW = "2026-10-08T07:30:00Z";
  writeFileSync(join(root, "mail.json"), JSON.stringify(MAIL));
  writeFileSync(join(root, "rules", "sources.yaml"), "sources:\n  gmail: { kind: gmail, fixture: mail.json }\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", "commit", "-qm", "owner: mail"], { cwd: root });
  const tok: Record<string, string> = { gardener: issueToken(root, "gardener"), planner: issueToken(root, "planner") };
  const remember = async (who: string, args: Record<string, unknown>) => {
    const res = await handle(root, new Request("http://pb/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: args } }), headers: { authorization: `Bearer ${tok[who]}` } }));
    const r: any = await res.json();
    return JSON.parse(r.result?.content?.[0]?.text ?? "{}") as { outcome: string; message: string; fails?: { check: string }[] };
  };
  const inbox = () => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).length : 0;
  return { root, remember, inbox };
}
const role = (value: string, sources = ["gmail:f000000000000001"]) => ({ id: "people/jane-roy", attribute: "role", value, as_of: "2026-10-01", sources, verification: "verified-by-source" });

test("a value the cited email says is proposed as before", async () => {
  const { remember, inbox } = setup();
  const r = await remember("gardener", role("Associate Dean at Northfield"));
  expect(r.outcome).toBe("inbox");
  expect(inbox()).toBe(1);
});

test("a value the cited email doesn't say is refused, with what to do instead, and nothing lands", async () => {
  const { remember, inbox } = setup();
  const r = await remember("gardener", role("Dean of Admissions"));
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0].check).toBe("source_says");
  expect(r.message).toMatch(/gmail:f000000000000001 doesn't say "Dean of Admissions"/);
  expect(r.message).toMatch(/source no longer supports people\/jane-roy#role/);
  expect(inbox()).toBe(0);
});

test("an email no fact in the Gardener's view cites isn't read: it is no way to read the owner's mail", async () => {
  const { remember } = setup();
  const r = await remember("gardener", role("5000 dollars", ["gmail:f000000000000009"]));
  expect(r.fails?.some((f) => f.check === "source_says") ?? false).toBe(false);
  expect(r.message).not.toMatch(/budget|doesn't say/);
});

test("another agent's write is untouched, and a value the word check can't judge goes on", async () => {
  const { remember } = setup();
  expect((await remember("planner", { ...role("Dean of Admissions"), id: "projects/course-a", attribute: "next_step" })).fails?.some((f) => f.check === "source_says") ?? false).toBe(false);
  expect((await remember("gardener", { ...role("2026-10-01"), attribute: "since" })).fails?.some((f) => f.check === "source_says") ?? false).toBe(false);
});

test("refusals are capped a day, so it isn't a word-by-word probe of an item", async () => {
  const { remember } = setup();
  for (let i = 0; i < SOURCE_SAYS_REFUSALS_PER_DAY; i++) expect((await remember("gardener", role(`Provost of Westbrook ${i}`))).fails?.[0].check).toBe("source_says");
  const r = await remember("gardener", role("Associate Dean at Northfield"));
  expect(r.outcome).toBe("refused");
  expect(r.message).toMatch(/No more proposals citing a source today/);
});
