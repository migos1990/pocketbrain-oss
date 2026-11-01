// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10, 2026-11-01 (finding 4c, G609): `start` printed the dashboard's reusable login key (the
// local, tailnet and https links) to stdout, which launchd writes to ~/Library/Logs/
// com.pocketbrain.start.log, created 0644, and which log rotation keeps. The key now goes only to a
// file in the brain's .git folder that only the owner can read; the hub's output names where it is.
import { test, expect } from "bun:test";
import { statSync, readFileSync } from "node:fs";
import { makeBrain } from "./fixture";
import { serveDashboard } from "../src/dashboard/server";
import { loginLinkFile, readLoginLink } from "../src/dashboard/login-link";

test("the dashboard keeps its sign-in link in an owner-only file, never in what start prints", () => {
  const root = makeBrain();
  const d = serveDashboard(root, { port: 0 });
  try {
    expect(d.loginUrl).toContain("/login?key=");
    const f = loginLinkFile(root);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readLoginLink(root)).toBe(d.loginUrl);
    expect(readFileSync(f, "utf8")).toContain(d.loginUrl);
    // What the hub prints: the address and where the link is, never the key.
    expect(d.loginSay).not.toContain("key=");
    expect(d.loginSay).toContain(f);
  } finally { d.server.stop(true); }
});

test("start's output never carries a login key (cli.ts, every dashboard line)", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const start = src.slice(src.indexOf('if (cmd === "start" || args.includes("--dashboard"))'), src.indexOf("// A stop (launchd, Ctrl-C)"));
  expect(start).toContain("serveDashboard(");
  expect(start).not.toMatch(/LoginUrl\}|loginUrl\}/);
});
