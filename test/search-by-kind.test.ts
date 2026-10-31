// SPDX-License-Identifier: AGPL-3.0-only
// Search by kind (backlog 354): search takes optional type and area filters, applied to the
// agent's own view after the carve, so "who is Jane" can ask for people only and a project note
// that mentions Jane doesn't rank first. A filter never widens the view, and an unknown kind
// finds nothing rather than failing.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { search } from "../src/core";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { resetBudgets } from "../src/budget";

test("type keeps only notes of that kind; area only notes in that area", () => {
  const root = makeBrain();
  const all = search(root, "steward", "course");
  expect(new Set(all.map((h) => h.type)).size).toBeGreaterThan(1);
  const people = search(root, "steward", "course", 20, { type: "person" });
  expect(people.map((h) => h.id)).toEqual(["people/jane-roy"]);
  const projects = search(root, "steward", "course", 20, { type: "project" });
  expect(projects.length).toBeGreaterThan(0);
  expect(projects.every((h) => h.type === "project")).toBe(true);
  const work = search(root, "steward", "course", 20, { area: "work" });
  expect(work.length).toBeGreaterThan(0);
  expect(work.every((h) => h.area === "work")).toBe(true);
  expect(search(root, "steward", "course", 20, { area: "personal" }).every((h) => h.area === "personal")).toBe(true);
});

test("a filter only narrows the agent's view, and an unknown kind finds nothing", () => {
  const root = makeBrain();
  const seen = new Set(search(root, "helper", "course").map((h) => h.id));
  for (const h of search(root, "helper", "course", 20, { type: "person" })) expect(seen.has(h.id)).toBe(true);
  expect(search(root, "steward", "course", 20, { type: "spaceship" })).toEqual([]);
});

test("the MCP search tool and GET /v1/search take type and area", async () => {
  resetBudgets();
  const root = makeBrain();
  const tok = issueToken(root, "steward");
  const auth = { authorization: `Bearer ${tok}` };
  const r = await (await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "course", type: "person" } } }) }))).json();
  expect(r.result.isError).toBe(false);
  expect(JSON.parse(r.result.content[0].text).map((h: { id: string }) => h.id)).toEqual(["people/jane-roy"]);
  const g = await (await handle(root, new Request("http://pb/v1/search?q=course&type=project", { headers: auth }))).json();
  expect(g.length).toBeGreaterThan(0);
  expect(g.every((h: { type: string }) => h.type === "project")).toBe(true);
});
