// SPDX-License-Identifier: AGPL-3.0-only
// "Who sees what" (src/dashboard/html-map.ts) on the video brain: each cell is the agent's own carve.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadState } from "../src/dashboard/data";
import { accessMap, mapGrid, mapPage } from "../src/dashboard/html-map";
import { revokeTokens } from "../src/auth";

const env = () => { const e: Record<string, string | undefined> = { ...process.env }; delete e.PB_NOW; delete e.PB_TODAY; return e; };
function videoBrain() {
  const dir = mkdtempSync(join(tmpdir(), "pb-map-"));
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "video-reset.ts"), "--no-serve"], { env: { ...env(), PB_VIDEO_DIR: dir } });
  expect(r.exitCode).toBe(0);
  // claude.ai and Alice come in through Auth0: one bound client, one coworker.
  writeFileSync(join(dir, "brain", "rules", "oauth.yaml"), YAML.stringify({ issuer: "https://example.us.auth0.com/", resource: "https://demo.example/mcp/oauth", owner_subject: "auth0|owner",
    clients: { "cid-claude": { agent: "claude", name: "claude.ai", bound: "2026-10-11" } }, coworkers: { "auth0|alice": { name: "Alice", agent: "alice" } } }));
  return join(dir, "brain");
}
const cell = (brain: string, agent: string, id: string) => accessMap(loadState(brain)).columns.find((c) => c.agent === agent)!.cells.get(id);
const off = (brain: string, agent: string) => accessMap(loadState(brain)).columns.find((c) => c.agent === agent)!.off;

test("who sees what: whole notes, cut notes, ask, nothing; a pause and a revoke darken the column", () => {
  const brain = videoBrain();
  expect(cell(brain, "claude", "projects/board-prep")).toBe("all");
  expect(cell(brain, "claude", "people/priya-nair")).toBe("part");          // contacts-basic: org and role only
  expect(cell(brain, "claude", "notes/board-feedback")).toBe("ask");        // private, may ask once
  expect(cell(brain, "claude", "notes/acquisition-talks")).toBe("none");    // deals are never offered
  expect(cell(brain, "claude", "money/exec-comp")).toBe("none");
  expect(cell(brain, "claude-code", "projects/platform-roadmap")).toBe("all");
  expect(cell(brain, "claude-code", "projects/board-prep")).toBe("ask");
  expect(cell(brain, "alice", "projects/q4-launch")).toBe("all");
  expect(off(brain, "gardener")).toBe("paused");                            // the reset trips its hours rule
  expect(off(brain, "town")).toBeUndefined();
  // The President's own agent is an operator for one task, the board deck: those notes, and it too has to ask.
  expect(off(brain, "robin")).toBeUndefined();
  for (const id of ["projects/board-prep", "projects/fy27-plan", "notes/exec-staff"]) expect(cell(brain, "robin", id)).toBe("all");
  expect(cell(brain, "robin", "notes/board-feedback")).toBe("ask");
  expect(cell(brain, "robin", "projects/platform-roadmap")).toBe("ask");
  expect(cell(brain, "robin", "money/exec-comp")).toBe("none");
  // Its receipts: what it read, in the read log.
  const reads = readFileSync(join(brain, "log", "reads.jsonl"), "utf8").split("\n").filter((l) => l.includes('"agent":"robin"'));
  expect(reads.length).toBeGreaterThanOrEqual(4);

  const file = join(brain, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["agents", "town", "status"], "paused");
  writeFileSync(file, doc.toString());
  expect(off(brain, "town")).toBe("paused");
  expect(cell(brain, "town", "projects/vp-sales-hire")).toBe("none");

  revokeTokens(brain, "claude-code");
  expect(off(brain, "claude-code")).toBe("no key");
  const html = mapPage(loadState(brain)).body;
  expect(html).toContain("Who sees what");
  expect(html).toContain("Priya&#39;s Claude Code");
  expect(mapGrid(loadState(brain))).toContain("no key");
});

test("as one assistant sees it: its column stands out, the notes it can't read fade, from the same carve", () => {
  const brain = videoBrain();
  const s = loadState(brain);
  const m = accessMap(s);
  const claude = m.columns.find((c) => c.agent === "claude")!;
  const readable = [...claude.cells.values()].filter((x) => x === "all" || x === "part").length;
  const page = mapPage(s, "claude");
  expect(page.title).toBe("As Maya's claude.ai sees it");
  const grid = mapGrid(s, "claude");
  expect(grid).toContain(`can read <b>${readable} of ${m.rows.length}</b> notes`);
  expect(grid).toContain('<tr class="m-gone"><td title="money/exec-comp">');            // never offered: faded
  expect(grid).not.toContain('<tr class="m-gone"><td title="projects/board-prep">');    // its own: not faded
  expect(grid).toContain('<tr><td title="people/priya-nair"><a href="/note/people/priya-nair">Priya Nair</a> <span class="sub">some facts cut</span>');
  // A paused assistant gets nothing; an unknown name or the resolver falls back to everyone.
  expect(mapGrid(s, "gardener")).toContain("can't get in right now (paused)");
  expect(mapPage(s, "steward").title).toBe("Who sees what");
  expect(mapGrid(s, "nobody")).not.toContain("m-gone");
});

test("an assistant that only signs in through Auth0 still gets Revoke access, and its sign-in is counted", () => {
  const brain = videoBrain();
  const { agentsPage } = require("../src/dashboard/html") as typeof import("../src/dashboard/html");
  const s = loadState(brain);
  const claude = s.agents.find((a) => a.name === "claude")!;
  expect(claude.tokens).toBe(0);
  expect(claude.signins).toBe(1);
  const row = agentsPage(s, "csrf").body.split("<tr").find((r) => r.includes("value=\"claude\""))!;
  expect(row).toContain("1 sign-in");
  expect(row).toContain("Revoke access");
});
