// SPDX-License-Identifier: AGPL-3.0-only
// A guessed hidden value in a new page's title answers like a missing page (audit v11, receipts
// row, reproduced on main; G648; invariant 3). A trial assistant's new page went to the inbox when
// its title held nothing hidden, but was refused with leak_tripwire when it held a value the
// assistant can't see, so the refusal confirmed the guess. Now both go to the inbox with the same
// reply; the owner is still alerted and the proposal is marked for the owner only.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { remember } from "../src/core";
import { readJsonl } from "../src/util";
import { git } from "../src/git";

// Course D's sponsor is hidden from helper (a trial assistant) by name in its grant.
function withSponsor() {
  const root = makeBrain();
  writeFileSync(join(root, "projects/course-d.md"), `---
id: projects/course-d
type: project
title: Course D
area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  sponsor: { value: Bluefin Holdings, as_of: 2026-10-01, sources: ["gmail:f000000000000004"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
---
`);
  const policy = join(root, "rules/policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }", "helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money], exclude: [projects/course-d#sponsor] }"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "course d"]);
  return root;
}
const page = (title: string) => ({ title, type: "org", area: "work", attribute: "what_it_is", value: "a company", as_of: "2026-10-05", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
const alerts = (root: string) => existsSync(join(root, "log/alerts.jsonl")) ? readJsonl<{ check?: string }>(join(root, "log/alerts.jsonl")).filter((a) => a.check === "leak_tripwire").length : 0;
const shape = (r: { outcome: string; message?: string; file?: string; fails?: unknown }) => JSON.stringify({ ...r, file: r.file ? "F" : undefined, message: (r.message ?? "").replace(/inbox\/\S+/g, "F") });

test("a trial assistant's new page answers the same whether its title holds a hidden value or a made-up one", () => {
  const root = withSponsor();
  const before = alerts(root);
  const hit = remember(root, "helper", page("Bluefin Holdings"));
  const miss = remember(root, "helper", page("Redfin Partners"));
  expect(miss.outcome).toBe("inbox");
  expect(shape(hit)).toBe(shape(miss));
  // The owner is still told, and only the guess's proposal carries the owner-only mark.
  expect(alerts(root)).toBe(before + 1);
  const doc = (f: string) => YAML.parse(readFileSync(join(root, f), "utf8")) as { leak?: boolean };
  expect(doc(hit.file!).leak).toBe(true);
  expect(doc(miss.file!).leak).toBeUndefined();
});

test("the same holds for a hidden value inside a longer title", () => {
  const root = withSponsor();
  const hit = remember(root, "helper", page("Receipt from Bluefin Holdings"));
  const miss = remember(root, "helper", page("Receipt from Redfin Partners"));
  expect(shape(hit)).toBe(shape(miss));
});

test("the hub's own filing never files the held guess; it stays for the owner", async () => {
  const { runAuto } = await import("../src/filing");
  const { loadBrain } = await import("../src/brain");
  const root = withSponsor();
  const hit = remember(root, "helper", page("Bluefin Holdings"));
  for (const h of [1, 30, 60]) runAuto(root, new Date(Date.parse("2026-10-08T14:00:00Z") + h * 3_600_000));
  expect(loadBrain(root).some((n) => /bluefin/i.test(String(n.fm.title)))).toBe(false);
  expect(existsSync(join(root, hit.file!)) || existsSync(join(root, "inbox/decided", hit.file!.split("/").pop()!))).toBe(true);
});

test("the owner's card says the guess carried a value the assistant can't see", async () => {
  const { proposals } = await import("../src/dashboard/data");
  const reason = (title: string) => { const root = withSponsor(); remember(root, "helper", page(title)); const ps = proposals(root); expect(ps).toHaveLength(1); return ps[0]!.reason; };
  expect(reason("Bluefin Holdings")).toMatch(/^It carried a value this assistant can't see/);
  expect(reason("Redfin Partners")).not.toMatch(/can't see/);
});

test("the audit's pair: a hidden money fact's value sharing words with a new receipt page's title", () => {
  const root = withSponsor();
  writeFileSync(join(root, "money/hydro.md"), `---
id: money/hydro
type: money
title: Utilities
area: personal
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  payee: { value: Hydro bill for the cottage, as_of: 2026-10-01, sources: ["gmail:f000000000000004"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }
---
`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "hydro"]);
  const hit = remember(root, "helper", page("Hydro bill"));
  const miss = remember(root, "helper", page("Phone bill"));
  expect(miss.outcome).toBe("inbox");
  expect(shape(hit)).toBe(shape(miss));
});
