// SPDX-License-Identifier: AGPL-3.0-only
// Agent refusal stats (docs/refusals.md): each tool call and API request is a line
// in log/calls.jsonl, and the week report lists per agent its tools, how often it is refused and
// with what, flags one refused more than 20% of the time, and names refusals it retries anyway.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { week } from "../src/measure";
import { refusalKind, routeName } from "../src/calls";

function setup() {
  const root = makeBrain();
  const tok: Record<string, string> = { planner: issueToken(root, "planner"), helper: issueToken(root, "helper") };
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[who]}` } }));
    return { status: res.status, text: await res.text() };
  };
  const tool = (who: string, name: string, args: Record<string, unknown> = {}) => call(who, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const lines = () => readFileSync(join(root, "log", "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { root, call, tool, lines };
}

test("a refusal's kind keeps its first words and drops ids, numbers, quotes, addresses and links", () => {
  expect(refusalKind('no note people/jane-roy in your view')).toBe("no note <id> in your view");
  expect(refusalKind('choice must be a side number, 1..3')).toBe("choice must be a side number, #..#");
  expect(refusalKind('value "Leo appealed his grade" is above your level')).toBe("value … is above your level");
  expect(refusalKind("from marc@example.com via url:https://x.test/a?b=c is refused")).not.toMatch(/marc|x\.test/);
  expect(refusalKind("x ".repeat(50)).split(" ").length).toBeLessThanOrEqual(8);
});

test("a route is logged by its resource, never a note's path or a dispute's number", () => {
  expect(routeName("GET", "/v1/notes/people/jane-roy")).toBe("GET /v1/notes");
  expect(routeName("GET", "/v1/notes/people")).toBe("GET /v1/notes");
  expect(routeName("POST", "/v1/disputes/c-0001/resolve")).toBe("POST /v1/disputes/resolve");
  expect(routeName("GET", "/v1/gardener/last")).toBe("GET /v1/gardener/last");
  expect(routeName("GET", "/v1/search")).toBe("GET /v1/search");
});

test("every tool call and API request is one line: the tool, and the refusal's kind when refused", async () => {
  const { tool, call, lines } = setup();
  await tool("planner", "orientation");
  await tool("planner", "read", { id: "nope/missing" });
  await tool("planner", "secret_tool_name_xyz");
  await tool("planner", "remember", { id: 42 });
  await call("planner", "GET", "/v1/notes/people/nobody-here");
  const ls = lines();
  expect(ls.map((l) => l.tool)).toEqual(["orientation", "read", "unknown tool", "remember", "GET /v1/notes"]);
  expect(ls[0].refused).toBeUndefined();
  expect(ls[1].refused).toBeDefined();
  expect(ls[2].refused).toBe("unknown tool");
  expect(ls[3].refused).toBeDefined(); // a call refused for its arguments counts too
  expect(ls[4].refused).toBeDefined();
  expect(JSON.stringify(ls)).not.toMatch(/nope\/missing|secret_tool_name|nobody-here/);
  expect(ls.every((l) => l.agent === "planner")).toBe(true);
});

test("the week report lists each agent's calls and refusals, flags one refused over 20%, and names refusals retried", async () => {
  const { root, tool } = setup();
  for (let i = 0; i < 3; i++) await tool("helper", "read", { id: "nope/missing" });
  await tool("helper", "orientation");
  for (let i = 0; i < 9; i++) await tool("planner", "orientation");
  await tool("planner", "read", { id: "nope/missing" });
  // Call lines carry the wall clock, like log/reads.jsonl: the week ends today by it.
  const { text } = week(root, new Date().toISOString().slice(0, 10));
  expect(text).toContain("## Agent refusals");
  expect(text).toMatch(/\| helper \| 4 \| 3 \(75%\) \|/);
  expect(text).toMatch(/\| planner \| 10 \| 1 \(10%\) \|/);
  expect(text).toMatch(/helper is refused 75% of the time/);
  expect(text).not.toMatch(/planner is refused/);
  expect(text).toMatch(/helper retried "read: [^"]+" 2 times/);
  expect(text).not.toContain("nope/missing");
});
