// SPDX-License-Identifier: AGPL-3.0-only
// A new agent's id is checked like its label (stranger rehearsal 3): `pocketbrain add st3ward`
// with no --name would show as "st3ward" everywhere, reading as steward.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { loadRules } from "../src/rules";
import { checkNewAgent } from "../src/addagent";

const add = (agent: string) => () => checkNewAgent(loadRules(makeBrain({ git: false })), { agent, slices: ["area:work"] } as never);

test("an id that reads as an existing agent or a hub role is refused; a plain new id is fine", () => {
  for (const id of ["st3ward", "p1anner", "gardener-bot", "pocketbrain-admin", "relay2"]) expect(add(id)).toThrow(/reads as/);
  expect(add("scout")).not.toThrow();
});

const owned = (name: string) => { const r = loadRules(makeBrain({ git: false })); r.policy.owner = { ...(r.policy.owner ?? {}), name } as never; return r; };

test("an id is read as the owner only by a whole part of the owner's name, not by letters inside a word", () => {
  const r = owned("Ann Lee");
  for (const id of ["scanner", "joanne", "banner-bot", "fleet"]) expect(() => checkNewAgent(r, { agent: id, slices: ["area:work"] } as never)).not.toThrow();
  for (const id of ["ann-bot", "lee", "annlee", "owner-helper"]) expect(() => checkNewAgent(r, { agent: id, slices: ["area:work"] } as never)).toThrow(/reads as you/);
});

test("a numbered copy of an existing agent's id is refused; assistant-2 from an access request is fine", () => {
  for (const id of ["steward-2", "planner2"]) expect(add(id)).toThrow(/reads as steward|reads as planner/);
  expect(add("assistant-2")).not.toThrow();
});

test("stacked numbers and a numbered owner's name don't get past the id check (re-audit R2, R3)", () => {
  for (const id of ["steward-2-2", "steward2-3"]) expect(add(id)).toThrow(/reads as steward/);
  const r = owned("Robin");
  for (const id of ["robin2", "robin1", "robin-2"]) expect(() => checkNewAgent(r, { agent: id, slices: ["area:work"] } as never)).toThrow(/reads as you/);
  expect(() => checkNewAgent(owned("Ann Lee"), { agent: "ann2", slices: ["area:work"] } as never)).toThrow(/reads as you/);
  expect(() => checkNewAgent(owned("Ann Lee"), { agent: "scanner2", slices: ["area:work"] } as never)).not.toThrow();
});

test("the number check stays fast on a long id of digits (re-audit N2)", () => {
  const t = Date.now();
  expect(add("a" + "1".repeat(29) + "x")).not.toThrow();
  expect(Date.now() - t).toBeLessThan(200);
});
