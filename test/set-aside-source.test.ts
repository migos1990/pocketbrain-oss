// SPDX-License-Identifier: AGPL-3.0-only
// The demo brain's home at 390px, 2026-11-06 (data-in-context thread, G673): the line for a fact the
// hub set aside from a no-reply mail read "From today's email" under it, though no email came that
// day; the hub did it. A line the hub set aside (machine mail, a receipt) says so instead.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { recordMachineMail } from "../src/louis";
import { setMachineMailAside } from "../src/ownerset";
import { upkeep } from "../src/upkeep";
import { homeView, SAID_COPY, fromWords } from "../src/dashboard/home";
import { clock } from "../src/clock";

const said = (root: string, words: RegExp) => {
  const view = homeView(root, loadRules(root), loadBrain(root), clock(), { all: true, fresh: true }) as unknown as Record<string, unknown>;
  const lines = JSON.parse(JSON.stringify(view, (_k, v) => v)) as unknown;
  const found: { what: string; said: string }[] = [];
  const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { const o = x as Record<string, unknown>; if (typeof o.what === "string" && typeof o.said === "string" && words.test(o.what)) found.push({ what: o.what, said: o.said }); Object.values(o).forEach(walk); } };
  walk(lines);
  return found.map((f) => f.said);
};

test("a fact the hub set aside from machine mail says the brain set it aside, not where it came from", () => {
  const root = makeBrain();
  write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov", sensitivity: "private", as_of: "2026-10-05", sources: ["gmail:f0000000000000a1"], verification: "verified-by-source" } as never);
  recordMachineMail(root, ["gmail:f0000000000000a1"]);
  setMachineMailAside(root, "on");
  upkeep(root, { run: "reflect-said" });
  const s = said(root, /no-reply mail/);
  expect(s.length).toBeGreaterThan(0);
  for (const x of s) { expect(x).not.toMatch(/email/i); expect(x).toBe(SAID_COPY.setAside.replace("{when}", "today")); }
  // The small line under it and a page's What changed say the same.
  expect(fromWords({ source_word: "email", by: "hub", why: "machine" } as never, loadRules(root))).toBe("set aside by your brain");
});

test("a receipt the hub set aside says the same", () => {
  const root = makeBrain();
  writeFileSync(join(root, "money", "apple-order-x1.md"), `---\nid: money/apple-order-x1\ntype: money\ntitle: Apple order X1\narea: personal\nsensitivity: private\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n  amount: { value: "12.99", as_of: 2026-10-28, sources: ["gmail:f000000000000031"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: unknown }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  upkeep(root, { run: "reflect-said-r" });
  const s = said(root, /receipt/i);
  expect(s.length).toBeGreaterThan(0);
  for (const x of s) expect(x).toBe(SAID_COPY.setAside.replace("{when}", "today"));
});
