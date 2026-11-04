// SPDX-License-Identifier: AGPL-3.0-only
// The diary says who said it (audit v4, 2026-10-26: 87 of 180 lines said "you said" where the owner
// wrote 13). A line says "you said" only when the owner wrote it; the owner's words carried by an
// assistant say so; and an approximate date stays approximate on the page.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrain } from "../src/brain";
import { homeView, fromWords } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { write } from "../src/write";
import { ownerSay } from "../src/owner-say";

test("'you said' only for the owner's own writes; an assistant carrying the owner's words says so", () => {
  const root = makeBrain();
  const rules = loadRules(root);
  expect(fromWords({ source_word: "you", by: "owner" }, rules)).toBe("you said");
  expect(fromWords({ source_word: "you", by: "louis" }, rules)).toBe("you said");
  const label = rules.policy.agents.planner?.label ?? "planner";
  expect(fromWords({ source_word: "you", by: "planner" }, rules)).toBe(`you told your ${label}`);
  mkdirSync(join(root, "diary"), { recursive: true });
  writeFileSync(join(root, "diary", "2026-10.jsonl"), JSON.stringify({ at: "2026-10-08T10:00:00Z", fact_key: "people/jane-roy#role", title: "Jane Roy", kind: "changed", to: "dean", source_word: "you", by: "planner", confidence: "stated", rank: 5, sources: 1, sensitivity: "personal", undo_token: "t1" }) + "\n");
  const v = homeView(root, rules, loadBrain(root), new Date("2026-10-08T15:00:00Z"), { all: true });
  expect(v.since[0]!.from).toStartWith(`you told your ${label}`);
});

test("a date said as 'last week' stays approximate on the page", async () => {
  const { dashboardHandler } = await import("../src/dashboard/server");
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy moved to Bay Institute last week").kind).toBe("say.noted");
  const H = "127.0.0.1:8798";
  const d = dashboardHandler(root, { port: 8798, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const page = await (await d.handle(new Request(`http://${H}/p/people/jane-roy`, { headers: { host: H, cookie } }))).text();
  expect(page).toMatch(/since around \d{1,2} [A-Z][a-z]{2} \d{4}/);
  void write;
});
