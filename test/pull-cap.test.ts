// SPDX-License-Identifier: AGPL-3.0-only
// max_per_day: items over the cap wait for the next day instead of being marked seen and lost,
// the cap counts every pass of the day, and a live cursor doesn't move past what wasn't read.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { pullSource } from "../src/pull";
import { makeModel } from "../src/model";

const model = makeModel({ provider: "fake", model: "f" }, { fake: () => JSON.stringify({ facts: [] }) });
const msg = (i: number) => ({ team: "T1", channel: "C9", channel_name: "#c", ts: `${1760000000 + i}`, user: "U1", text: `Distinct message number ${i} about the course plans` });
const today = process.env.PB_TODAY;
afterEach(() => { if (today === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = today; });
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { s: { kind: "slack", max_per_day: 2 } } }));
  return root;
}
const state = (root: string) => JSON.parse(readFileSync(join(root, "log", "sources", "s.json"), "utf8"));

test("over the cap, the rest waits for the next day instead of being lost", async () => {
  const root = brain();
  const items = [1, 2, 3, 4, 5].map(msg);
  process.env.PB_TODAY = "2026-10-15";
  const r1 = await pullSource(root, "s", { fetch: () => items, model });
  expect(r1.stored.length).toBe(2);
  expect(r1.capped).toBe(true);
  expect(Object.keys(state(root).seen).length).toBe(2);
  expect((await pullSource(root, "s", { fetch: () => items, model })).stored.length).toBe(0); // same day: still capped
  process.env.PB_TODAY = "2026-10-16";
  expect((await pullSource(root, "s", { fetch: () => items, model })).stored.length).toBe(2);
  process.env.PB_TODAY = "2026-10-17";
  const r4 = await pullSource(root, "s", { fetch: () => items, model });
  expect(r4.stored.length).toBe(1);
  expect(r4.capped).toBeUndefined();
});

test("the cap counts every pass of the day, not each pass alone", async () => {
  const root = brain();
  process.env.PB_TODAY = "2026-10-15";
  expect((await pullSource(root, "s", { fetch: () => [1, 2].map(msg), model })).stored.length).toBe(2);
  const r = await pullSource(root, "s", { fetch: () => [6, 7].map(msg), model });
  expect(r.stored.length).toBe(0);
  expect(r.capped).toBe(true);
});

test("a capped pass keeps the source's own cursor, so a cursor source reads the rest later", async () => {
  const root = brain();
  process.env.PB_TODAY = "2026-10-15";
  const r = await pullSource(root, "s", { fetch: () => ({ items: [1, 2, 3].map(msg), cursor: "c-after-3", more: true }), model });
  expect(r.capped).toBe(true);
  expect(r.more).toBeUndefined();
  expect(state(root).live).toBeUndefined();
  const ok = await pullSource(root, "s", { fetch: () => ({ items: [1].map(msg), cursor: "c-after-1" }), model });
  expect(ok.stored.length).toBe(0);
  expect(state(root).live).toBe("c-after-1");
});
