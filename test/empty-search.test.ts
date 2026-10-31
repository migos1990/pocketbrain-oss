// SPDX-License-Identifier: AGPL-3.0-only
// An empty search says why (backlog 317, docs/agent-instructions.md): that none of the query words
// is in a note of the agent's view, and the next step. Built from the query alone, so a word that is only
// in notes outside the view answers exactly like a word that is nowhere.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import * as core from "../src/core";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";

async function tool(root: string, agent: string, name: string, args: Record<string, unknown>) {
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${issueToken(root, agent)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return JSON.parse((await res.json()).result.content[0].text);
}

test("no hit names the words found nowhere in the view, and the next step", () => {
  const root = makeBrain();
  const e = core.emptySearch(root, "helper", "zanzibar ferry");
  expect(e.hits).toEqual([]);
  expect(e.searched).toBe(2);
  expect(e.why).toBe("None of the 2 words you searched for is in any note in your view.");
  // never repeated back: the carve property check reads an echoed hidden name as a leak
  expect(JSON.stringify(e)).not.toContain("zanzibar");
  expect(e.next).toContain("related word");
  expect(e.next).toContain("Robin"); // the fixture's owner
  expect(e.next).toContain("not another assistant");
});

test("a word only in notes outside the view answers exactly like a word that is nowhere", () => {
  const root = makeBrain();
  // helper's slice excludes money: "Maple" is only in money/main-bank
  expect(core.search(root, "steward", "maple").length).toBeGreaterThan(0);
  expect(core.search(root, "helper", "maple")).toEqual([]);
  const hidden = core.emptySearch(root, "helper", "maple");
  const nowhere = core.emptySearch(root, "helper", "zzqqxx");
  expect(hidden).toEqual(nowhere);
});

test("only common words, an empty query, an address", () => {
  const root = makeBrain();
  expect(core.emptySearch(root, "helper", "the of").why).toBe("Search skips common words (the, of, de, la…), and that's all this query has.");
  expect(core.emptySearch(root, "helper", "zanzibar").why).toBe("The word you searched for is in no note in your view.");
  expect(core.emptySearch(root, "helper", "  ").why).toBe("The query is empty.");
  expect(core.emptySearch(root, "helper", "nobody@example.org").next).toContain("who_is");
});

test("the search tool returns the reason with an empty list, and plain hits otherwise", async () => {
  const root = makeBrain();
  const empty = await tool(root, "helper", "search", { query: "zanzibar" });
  expect(empty).toMatchObject({ hits: [], searched: 1 });
  expect(empty.why).toContain("no note in your view");
  const some = await tool(root, "helper", "search", { query: "course" });
  expect(Array.isArray(some)).toBe(true);
  expect(some.length).toBeGreaterThan(0);
  // a limit of 0 or below still searches: the reason is only given when nothing matches
  for (const limit of [0, -3]) expect(Array.isArray(await tool(root, "helper", "search", { query: "course", limit }))).toBe(true);
});
