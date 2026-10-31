// SPDX-License-Identifier: AGPL-3.0-only
// What an assistant is told about its writes matches what write() does (audit v3, 2026-10-26: every
// assistant was still told its writes outside its area were proposals that waited for the owner,
// after file-in-write made them file themselves, G422).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { orientation } from "../src/core";
import { write } from "../src/write";

test("a core assistant is told its facts file themselves and a contradiction is a conflict, as write() does", () => {
  const root = makeBrain();
  const o = orientation(root, "planner", "mcp");
  expect(o.text).not.toContain("becomes a proposal");
  expect(o.text).toContain("file themselves");
  expect(o.text).toContain('filed as a conflict beside it (outcome "disputed")');
  expect(o.text).not.toContain("neither value is used until");
  expect(o.contract).not.toContain("outside your own area it waits");
  expect(o.contract).toContain("it files itself");
  // And write() agrees: outside its area, a new fact from the planner is committed, not proposed.
  const r = write(root, { agent: "planner", type: "person", area: "personal", title: "Lena Ortiz", attribute: "role", value: "Registrar", as_of: "2026-10-07", sources: ["gmail:f000000000000004"] });
  expect(r.outcome).toBe("committed");
});

test("a trial assistant is still told every write is a proposal; a gardener made core is told it files", () => {
  const root = makeBrain();
  expect(orientation(root, "helper", "mcp").text).toContain("every write is a proposal");
  expect(orientation(root, "gardener", "mcp").text).toContain("You are on trial, so for now you only propose");
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^(  gardener: \{ tier: )trial/m, "$1core"));
  const g = orientation(root, "gardener", "mcp").text;
  expect(g).toContain("your facts file themselves like any core assistant's");
  expect(g).not.toContain("only propose");
});
