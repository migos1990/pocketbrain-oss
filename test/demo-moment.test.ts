// SPDX-License-Identifier: AGPL-3.0-only
// The demo moment (outside review 2026-10-29, docs/demo-moment.md): ask Claude "what's next with
// Jane", get an answer that cites the brain and is right; tell the box one thing on the phone and
// Claude knows it a minute later. context_pack is what Claude reads, so it must (G503) answer a
// name it doesn't hold with "no note about" instead of notes that only share another word, and
// (G504) carry a Cite line per note naming the page and each fact's source in words.
import { test, expect, afterEach } from "bun:test";
import { makeBrain } from "./fixture";
import { contextPack } from "../src/core";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { dashboardHandler } from "../src/dashboard/server";
import { useCells } from "../src/cell";

afterEach(() => useCells(false));

test("a name the view doesn't hold is said, and notes that share only another word are left out (G503)", () => {
  const root = makeBrain();
  const out = contextPack(root, "planner", "what's next with Zoe");
  expect(out).toContain('No note about "Zoe" in your view');
  expect(out).not.toContain("### Course A"); // shares only "next"
});

test("a named person comes first with the notes linked to her, and nothing that only shares a word (G503)", () => {
  const root = makeBrain();
  const out = contextPack(root, "planner", "what's next with Jane");
  const heads = [...out.matchAll(/^### (.+) `/gm)].map((m) => m[1]);
  expect(heads[0]).toBe("Jane Roy");
  expect(heads).toContain("Course A"); // Jane coordinates it: its next step is hers to know
  expect(out).not.toContain("No note about");
});

test("each note carries a Cite line: the page and each fact's source in words, no raw ids (G504)", () => {
  const root = makeBrain();
  const out = contextPack(root, "planner", "what's next with Jane");
  const cite = out.split("\n").find((l) => l.startsWith("Cite as: (from your brain: Jane Roy;"))!;
  expect(cite).toBeDefined();
  expect(cite).toContain("role: Email 2026-09-01");
  expect(cite).not.toContain("gmail:");
});

// The round trip on the hub's own path: the owner's box (dashboard POST /say) commits, and the
// next MCP context_pack, served from the agent's cell, has it with "Your note" as its source.
test("told on the home, known over MCP well under a minute, cited as the owner's note", async () => {
  useCells(true);
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  const mcp = async (topic: string) => {
    const r = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: { topic } } }) }));
    return ((await r.json()) as any).result.content[0].text as string;
  };
  expect(await mcp("what's next with Jane")).not.toContain("send the syllabus");
  const H = "127.0.0.1:8793";
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const hdr = { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home` };
  const csrf = (await (await d.handle(new Request(`http://${H}/home`, { headers: hdr }))).text()).match(/name="csrf" value="([^"]+)"/)![1]!;
  const t0 = performance.now();
  const said = await d.handle(new Request(`http://${H}/say`, { method: "POST", headers: { ...hdr, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, q: "Jane Roy's next step is send the syllabus by Friday" }) }));
  expect(await said.text()).toContain("Noted");
  let known = "";
  while (performance.now() - t0 < 60_000 && !known.includes("send the syllabus")) known = await mcp("what's next with Jane");
  const ms = performance.now() - t0;
  expect(known).toContain("send the syllabus by Friday");
  expect(known).toMatch(/Cite as: \(from your brain: Jane Roy; next_step: Your note \d{4}-\d{2}-\d{2}/);
  expect(ms).toBeLessThan(60_000);
});
