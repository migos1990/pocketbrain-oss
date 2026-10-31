// SPDX-License-Identifier: AGPL-3.0-only
// The Mac, 2026-10-24: after the stale alerts closed on the dashboard and in the text, doctor still
// said "FAIL ops 12 hub alert(s) this week". Checks fail only on real failures: doctor counts the
// hub's alerts that are still open, by the same rule the owner queue uses.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { doctor } from "../src/doctor";

test("doctor fails only on hub alerts still open, not ones whose check has passed since", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  appendFileSync(join(root, "log", "alerts.jsonl"), JSON.stringify({ at, agent: "hub", check: "probe_gardener_rotate", from: "old key" }) + "\n");
  writeFileSync(join(root, "log", "probe.json"), JSON.stringify({ gardener_rotate: { ok: false, since: at, detail: "old key" } }));
  const fails = async () => (await doctor(root, { offline: true })).filter((f) => f.id === "doctor.hub-alerts");
  expect(await fails()).toHaveLength(1);
  writeFileSync(join(root, "log", "probe.json"), JSON.stringify({ gardener_rotate: { ok: true, since: new Date().toISOString(), detail: "" } }));
  expect(await fails()).toHaveLength(0);
});
