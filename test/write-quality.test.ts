// SPDX-License-Identifier: AGPL-3.0-only
// Per-agent write quality (backlog 298): over 30 days, how many of an assistant's own writes the
// owner kept, corrected or reverted, and how many of its proposals were accepted. Below the floor
// the hub suggests making it a trial agent, so its writes wait for the owner; it never changes the
// tier itself (rules/ is the owner's).
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { setFact, revertCommit } from "../src/dashboard/edit";
import { git } from "../src/git";
import { writeQuality } from "../src/writequality";
import { week } from "../src/measure";
import { dashboardHandler } from "../src/dashboard/server";

const today = () => new Date().toISOString().slice(0, 10);
function remember(root: string, agent: string, id: string, attribute: string, value: string) {
  const r = write(root, { agent, id, attribute, value, as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } as never);
  expect(`${r.outcome}: ${r.message}`).toStartWith("committed");
  return git(root, ["rev-parse", "HEAD"]);
}
// A proposal the owner already decided, as the inbox keeps it.
function decided(root: string, agent: string, decision: "accept" | "reject", n: number, on = today()) {
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  writeFileSync(join(root, "inbox", "decided", `${on}-${agent}-${decision}-${n}.yaml`), YAML.stringify({ proposed: on, decided: on, decision, request: { agent, id: "projects/course-a", attribute: `x${n}`, value: "v" } }));
}

test("counts the agent's writes the owner kept, corrected and reverted, and its proposals' outcomes", () => {
  const root = makeBrain();
  remember(root, "planner", "projects/course-a", "next_step", "Send the syllabus");
  remember(root, "planner", "projects/course-a", "room", "B-201");
  const bad = remember(root, "planner", "projects/course-b", "next_step", "Book the hall");
  setFact(root, "projects/course-a", "room", "B-305"); // the owner corrected it
  revertCommit(root, bad); // the owner reverted it
  decided(root, "planner", "accept", 1);
  decided(root, "planner", "reject", 2);
  decided(root, "helper", "reject", 3); // someone else's
  const q = writeQuality(root, "planner");
  expect(q).toMatchObject({ writes: 3, kept: 1, corrected: 1, reverted: 1, accepted: 1, rejected: 1, judged: 5, suggestTrial: false });
  expect(q.keepRate).toBeCloseTo(2 / 5);
  // Under the floor but with too few to judge: no suggestion yet.
  expect(q.suggestTrial).toBe(false);
  // A write or a decision older than the window doesn't count.
  decided(root, "planner", "reject", 4, "2026-01-01");
  expect(writeQuality(root, "planner").rejected).toBe(1);
  // An agent with nothing yet.
  expect(writeQuality(root, "helper")).toMatchObject({ writes: 0, accepted: 0, rejected: 1, judged: 1 });
});

async function page(root: string, path: string) {
  const H = "127.0.0.1:8796";
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  return (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }))).text();
}
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("the agent's page shows its write quality and, under the floor, suggests trial without changing the tier", async () => {
  const root = makeBrain();
  remember(root, "planner", "projects/course-a", "next_step", "Send the syllabus");
  for (let i = 0; i < 10; i++) decided(root, "planner", i < 2 ? "accept" : "reject", i);
  const policy = readFileSync(join(root, "rules", "policy.yaml"), "utf8");
  const t = plain(await page(root, "/agent/planner"));
  expect(t).toContain("1 write in 30 days: 1 kept, 0 corrected, 0 reverted");
  expect(t).toContain("10 proposals: 2 accepted, 8 rejected");
  expect(t).toContain("27% kept");
  expect(t).toMatch(/consider making Planner a trial agent/i);
  expect(t).toContain("won't change it");
  expect(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).toBe(policy);
  // A trial agent is already propose-only: no suggestion.
  for (let i = 10; i < 20; i++) decided(root, "helper", "reject", i);
  expect(plain(await page(root, "/agent/helper"))).not.toMatch(/consider making/i);
  // Nothing written yet.
  expect(plain(await page(root, "/agent/steward"))).toContain("nothing written in 30 days");
});

test("the week report lists each assistant under the floor with the same suggestion", () => {
  const root = makeBrain();
  for (let i = 0; i < 10; i++) decided(root, "planner", i < 2 ? "accept" : "reject", i);
  const { text } = week(root);
  expect(text).toContain("## Agent write quality");
  expect(text).toContain("planner: 0 writes in 30 days: 0 kept, 0 corrected, 0 reverted; 10 proposals: 2 accepted, 8 rejected (20% kept)");
  expect(text).toMatch(/consider making planner a trial agent/i);
});
