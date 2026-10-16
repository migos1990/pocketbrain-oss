// SPDX-License-Identifier: AGPL-3.0-only
// Memory import (src/memimport.ts, docs/memory-sync.md): an assistant's memory or the owner's own
// notes become proposals through the capture pipeline, never commits; an agent's memory is cited
// as its own word; opaque agents are asked for theirs through memory_check.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { makeModel, type ModelRequest } from "../src/model";
import { extractPending } from "../src/capture";
import { importMemory, readMemory } from "../src/memimport";
import { askDump, chunks, state } from "../src/memsync";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

// The model proposes; the checks decide. One known value, one change, one it made up.
const model = () => makeModel({ provider: "fake", model: "fake-1" }, { fake: (_r: ModelRequest) => JSON.stringify({ facts: [
  { entity: "Jane Roy", type: "person", attribute: "role", value: "Course coordinator", quote: "Jane Roy is the course coordinator" },
  { entity: "Course A", type: "project", attribute: "next_step", value: "Print the midterm", quote: "Course A: next step is to print the midterm" },
  { entity: "Jane Roy", type: "person", attribute: "org", value: "Acme", quote: "Jane works at Acme" },
] }) });

const MEMORY = "# What I know\n\nJane Roy is the course coordinator.\n\nCourse A: next step is to print the midterm.\n";
const proposals = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).map((f) => YAML.parse(readFileSync(join(root, "inbox", f), "utf8")));

test("an agent's memory files become proposals citing the agent's own word; known values and made-up ones are not proposed", async () => {
  const root = makeBrain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  writeFileSync(join(dir, "memory.md"), MEMORY);
  const [r] = await importMemory(root, "planner", [dir], model());
  expect(r.result.items.map((i) => i.status).sort()).toEqual(["changes", "known", "ungrounded"]);
  const ps = proposals(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].request).toMatchObject({ agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Print the midterm", source_type: "agent_observation" });
  expect(ps[0].reason).toContain('from "Grade the midterm"');
  // Importing the same memory again is a no-op.
  expect((await importMemory(root, "planner", [dir], model()))[0].result.duplicate).toBe(true);
});

test("the owner's own notes are the owner's word; a JSON export is read as its text", async () => {
  const root = makeBrain();
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  writeFileSync(join(dir, "export.json"), JSON.stringify({ memories: [{ text: "Jane Roy is the course coordinator." }, { text: "Course A: next step is to print the midterm." }] }));
  expect(readMemory([dir])[0].text).toBe("Jane Roy is the course coordinator.\nCourse A: next step is to print the midterm.");
  await importMemory(root, "me", [dir], model());
  expect(proposals(root)[0].request.source_type).toBe("owner_message");
  await expect(importMemory(root, "nobody", [dir], model())).rejects.toThrow("no agent nobody");
});

test("an opaque agent is asked through memory_check; its answer is stored as its own word, for the owner to review", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "helper");
  const call = async (method: string, body?: unknown) => (await handle(root, new Request("http://pb/v1/memory-check", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok}` } }))).json() as Promise<any>;
  expect((await call("GET")).tell_me).toBeUndefined();
  expect(askDump(root, "helper")).toContain("helper is asked");
  expect(askDump(root, "helper")).toContain("already waiting");
  const check = await call("GET");
  expect(check.tell_me.prompt).toContain("Answer from your own memory");
  // Another agent can't answer it.
  const other = issueToken(root, "planner");
  const no = await (await handle(root, new Request("http://pb/v1/memory-check", { method: "POST", body: JSON.stringify({ memory_dump: { id: check.tell_me.id, text: MEMORY } }), headers: { authorization: `Bearer ${other}` } }))).json() as any;
  expect(no.memory_dump).toBe("no such request waiting");
  const r = await call("POST", { memory_dump: { id: check.tell_me.id, text: MEMORY } });
  expect(r.memory_dump).toContain("1 part(s) kept");
  expect((await call("GET")).tell_me).toBeUndefined();
  expect(proposals(root)).toHaveLength(0); // nothing until extraction, and then only proposals
  await extractPending(root, model());
  const ps = proposals(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].request).toMatchObject({ agent: "helper", source_type: "agent_observation" });
  expect(state(root).dumps[0].state).toBe("received");
});

test("memory is cut under the capture size limit at paragraph breaks", () => {
  const text = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
  expect(chunks(text, 90)).toEqual([`${"a".repeat(40)}\n\n${"b".repeat(40)}`, "c".repeat(40)]);
});
