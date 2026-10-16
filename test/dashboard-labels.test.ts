// SPDX-License-Identifier: AGPL-3.0-only
// What the owner reads on camera: agents by their policy label, the brain by its owner's name,
// proposals, held messages and the gardener's alert in plain words, and a line when the read
// log checks out. Code names stay on hover only.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { search } from "../src/core";
import { hoursTripwire } from "../src/gardener";
import { loadState } from "../src/dashboard/data";
import { overview, activityPage, layout } from "../src/dashboard/html";

test("the dashboard names agents by label and speaks plainly on the filmed screens", () => {
  const root = makeBrain();
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["agents", "helper", "label"], "claude.ai");
  doc.setIn(["agents", "gardener", "label"], "Gardener");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));

  const w = write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "Book the room", as_of: "2026-03-09", sources: ["gmail:f000000000000005"], verification: "verified-by-source" });
  expect(w.outcome).toBe("inbox");
  search(root, "helper", "course");
  expect(hoursTripwire(root, "gardener", new Date("2026-10-10T12:37:00Z"))).toBe(true); // 8:37 am in Toronto
  mkdirSync(join(root, "comms", "2026-10-10"), { recursive: true });
  writeFileSync(join(root, "comms", "2026-10-10", "m1.md"), `---\nfrom: planner\nto: helper\nsubject: Wednesday\nat: 2026-10-10T12:00:00Z\nverdict: held\nreasons:\n  - 'contains "Plumber comes Wednesday", which helper can''t see (projects/course-a#next_step)'\n---\nPlumber comes Wednesday\n`);

  const s = loadState(root);
  const page = layout({ root }, overview(s, "x"));
  expect(page).toContain(">Robin&#39;s brain</span>");
  expect(page).toContain('<span title="helper">claude.ai</span>');
  expect(page).toContain("claude.ai only proposes. Approve to apply.");
  expect(page).toContain("from an email, Mar 9");
  expect(page).toContain("which <span title=\"helper\">claude.ai</span> can't see");
  expect(page).toMatch(/mentions <span title="projects\/course-a#next_step">Course A: next step<\/span>/);
  expect(page).toContain("key was used at 8:37 am, outside its hours (3:25 to 5:00 am, or Sundays 9:55 am to 12:00 pm). It's paused.");
  expect(page).not.toContain("token --revoke");
  expect(page).not.toContain("is a trial agent");
  expect(page).not.toContain(`>${root}<`);
  expect(activityPage(s).body).toContain("Log checks out: no line was changed since it was written.");
});

test("a write that claims the owner's word the owner never gave is shown as claimed to be you", () => {
  const root = makeBrain();
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["agents", "helper", "label"], "Theo's Claude Code");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  const w = write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "Share the pay band with Theo", as_of: "2026-03-09", sources: ["owner:2026-03-09/approval"], verification: "confirmed-by-owner" });
  expect(w.outcome).toBe("inbox");
  const page = layout({ root }, overview(loadState(root), "x"));
  expect(page).toContain('<span class="kind k-alert"><span title="owner_message_registered">claimed to be you</span></span>');
  expect(page).toContain("says you approved this. You never did, so it waits for you.");
  expect(page).toContain("claims to be from you");
  expect(page).not.toContain("not in the owner&#39;s registry");
});

test("a proposal routed to the inbox before the registry check still shows an unregistered owner ref as claimed to be you; a capture's own ref and a registered one don't (backlog 247)", () => {
  const root = makeBrain();
  // steward is core but doesn't own the work area: its write is routed to the inbox by area
  // ownership, before the owner-word check ever runs, so the reason doesn't say it.
  const w = write(root, { agent: "steward", id: "projects/course-a", attribute: "next_step", value: "Share the pay band with Theo", as_of: "2026-03-09", sources: ["owner:2026-03-09/approval"], verification: "confirmed-by-owner" });
  expect(w.outcome).toBe("inbox");
  const page = () => layout({ root }, overview(loadState(root), "x"));
  expect(page()).toContain("says you approved this. You never did, so it waits for you.");
  // Once the id is the owner's (registered), the same card is an ordinary change to approve.
  writeFileSync(join(root, "rules", "owner-messages.yaml"), YAML.stringify({ messages: [{ id: "owner:2026-03-09/approval", added: "2026-03-09" }] }));
  expect(page()).not.toContain("You never did");
  // A capture's proposal cites the capture as the owner's word by design: no alert.
  const other = makeBrain();
  mkdirSync(join(other, "inbox"), { recursive: true });
  writeFileSync(join(other, "inbox", "cap.yaml"), YAML.stringify({ proposed: "2026-03-09", by: "hub", reason: "from your capture", checks: ["capture"], capture: "inbox/captures/2026-03-09-abc.md", request: { agent: "hub", id: "projects/course-a", attribute: "next_step", value: "Book the room", sources: ["owner:2026-03-09/capture/abc"] } }));
  expect(layout({ root: other }, overview(loadState(other), "x"))).not.toContain("You never did");
});
