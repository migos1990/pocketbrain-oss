// SPDX-License-Identifier: AGPL-3.0-only
// A private value from a mail whose sender no page holds waits under the serving hold (2026-10-27:
// 10 of the real brain's 15 open proposals were these, on the old deck only). The home's Waiting
// row says where it came from in the owner's words, never the address, and Show releases it.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { markSeen } from "../src/seen";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { homeView } from "../src/dashboard/home";

test("a held value from an unknown sender says so on the home, and Show releases it", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "home_town", value: "Rimouski-Est", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  Object.assign(n.fm.facts!.home_town as FactRecord, { sender: "unknown" });
  saveNote(root, n);
  const row = homeView(root, loadRules(root), loadBrain(root), new Date()).waiting.find((w) => w.seen === "people/jane-roy#home_town")!;
  expect(`${row.what} · ${row.verb}`).toBe("Something new about Jane Roy. · from an address your pages don't hold · only you can see it yet");
  expect(JSON.stringify(row)).not.toContain("Rimouski");
  expect(markSeen(root, "people/jane-roy#home_town").outcome).toBe("seen");
  expect(homeView(root, loadRules(root), loadBrain(root), new Date()).waiting.some((w) => w.seen === "people/jane-roy#home_town")).toBe(false);
});

test("a held value from a known sender keeps the short row", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "home_town", value: "Rimouski-Est", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  const row = homeView(root, loadRules(root), loadBrain(root), new Date()).waiting.find((w) => w.seen === "people/jane-roy#home_town")!;
  expect(row.verb).toBe("only you can see it yet");
});
