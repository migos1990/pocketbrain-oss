// SPDX-License-Identifier: AGPL-3.0-only
// The Mac, c1404d28, 2026-11-02 (G626): the home said 12 (1 to settle, 11 held values) while the
// north star counted 10 asks (1 conflict, 9 waiting on Settings). The two lists shared one item.
// Under the count rule the owner's home number and the north star's asks are one list: whatever
// waits on the owner is on the home once and in asks once. Which items count is the owner's typed
// word; this case holds either choice to the home equalling asks.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { waitingCount } from "../src/dashboard/home";
import { unseenFacts } from "../src/seen";
import { homeView } from "../src/dashboard/home";
import { homePage, APP_COPY } from "../src/dashboard/html-app";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

test("what the home counts and what the north star counts as asks are the same list", async () => {
  const { measure } = await import("../scripts/north-star");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["add", "rules/escalation.yaml"]); git(root, ["commit", "-q", "-m", "owner: file all"]);
  // A held value: an assistant's private value, saved unseen until the owner taps Show it.
  expect(write(root, { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "office", value: "Room 9", sensitivity: "private", as_of: "2026-10-05", sources: ["gmail:f000000000000004"] } as never).outcome).toBe("committed");
  expect(write(root, { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "phone", value: "514 555 0199", sensitivity: "private", as_of: "2026-10-05", sources: ["gmail:f000000000000005"] } as never).outcome).toBe("committed");
  expect(unseenFacts(root)).toHaveLength(2);
  // A Settings item: a name that fits a page and a new one (held_by_ambiguity).
  expect(write(root, { agent: "planner", kind: "fact", title: "Jan Roy", type: "person", area: "work", attribute: "office", value: "Room 4", as_of: "2026-10-05", sources: ["gmail:f000000000000006"] } as never).outcome).toBe("inbox");
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.home_asks).toBe(waitingCount(root, new Date(now.getTime() + 36 * 3_600_000)));
  expect({ home: m.home_asks, asks: m.asks }).toEqual({ home: m.asks, asks: m.asks });
  expect(m.asks_by_kind.held_by_serving).toBe(2);
  // The home names what waits on Settings in the owner's words, with one way there.
  const html = homePage(homeView(root, loadRules(root), loadBrain(root), new Date()), "c");
  expect(html).toContain("1 name that fits two pages.");
  expect(html).toContain(`>${APP_COPY.openSettings}</a>`);
}, 60_000);

// Review of #53: a proposal the home lists as a conflict (G622) is asked there, never named again
// on the Settings card under the rule that held it.
test("a by-name proposal that is a conflict on the home is not also on the Settings card", async () => {
  const { measure } = await import("../scripts/north-star");
  const { mkdirSync } = await import("node:fs");
  const YAML = (await import("yaml")).default;
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["add", "rules/escalation.yaml"]); git(root, ["commit", "-q", "-m", "owner: file all"]);
  write(root, { agent: "owner", id: "people/jane-roy", attribute: "health_note", value: "x", as_of: "2026-10-07", sources: ["owner:2026-10-07/home"], verification: "confirmed-by-owner", sensitivity: "private" } as never, { owner: true });
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-by-name.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "steward", reason: "a page holding a private fact", request: { agent: "steward", kind: "fact", type: "person", title: "Jane Roy", attribute: "role", value: "Dean of studies", as_of: "2026-10-07", sources: ["gmail:f000000000000005"], verification: "verified-by-source" } }));
  git(root, ["add", "inbox"]); git(root, ["commit", "-q", "-m", "steward: proposal by name"]);
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.home_asks).toBe(m.asks);
  const { ownerAsks } = await import("../src/waiting");
  const a = ownerAsks(root, now);
  expect(a.settings).toBe(0);
  expect(Object.keys(a.by).filter((k) => k.startsWith("held_by_") && k !== "held_by_serving")).toEqual([]);
}, 60_000);
