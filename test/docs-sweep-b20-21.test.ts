// SPDX-License-Identifier: AGPL-3.0-only
// Docs-vs-code sweep of batches 20 and 21 (backlog 238): each doc line below was wrong about the
// code it describes. These pin the corrected wording to the code, so the two can't drift apart again.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const text = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("release.md: the e2e suite runs in CI only, not in the pre-push hook", () => {
  expect(text(".githooks/pre-push")).not.toMatch(/scripts\/e2e\.ts|run e2e/);
  expect(text("docs/release.md")).toContain("the git pre-push hook runs the plain `bun test` and the evals");
});

test("edge.md: resolver tokens are the ones left out of a publish", () => {
  expect(text("src/edge.ts")).toMatch(/reader/);
  expect(text("docs/edge.md")).toContain("- **Resolver tokens.** Only plain and reader tokens are wrapped");
});

test("the review role has no step, so no doc says a role moves a step onto it", async () => {
  const src = text("src/model.ts");
  const map = src.slice(src.indexOf("STEP_ROLES"), src.indexOf("};", src.indexOf("STEP_ROLES")));
  expect(map).not.toMatch(/:\s*"review"/);
  for (const f of ["README.md", "docs/usage.md", "CLAUDE.md", "evals/README.md"]) {
    expect(text(f)).not.toMatch(/moves? a step onto it|unless you move one there|for any step moved there|a `review` role strongest/);
  }
});

test("relay docs: held mail names each side separately, alerts are per message and cause", () => {
  expect(text("docs/text-channel.md")).toContain("Held mail names each side only when it is an agent in `policy.yaml`");
  expect(text("README.md")).toContain("once a day per message and cause");
});

test("consent docs: the eval model is pinned on Anthropic, and no comment names a variable nothing reads", () => {
  expect(text("docs/consent.md")).not.toContain("routed like the product");
  expect(text("evals/cases/consent.ts")).not.toContain("EVAL_CONSENT_PROVIDER");
});

test("silent sources wait for silent_after_hours, not a fixed 72 hours", () => {
  expect(text("src/fill.ts")).toContain("silent_after_hours");
  expect(text("docs/sources-pull.md")).toContain("watched from its `silent_after_hours` (default 72)");
});

// Since G201 and G280 (claude/cli-token-pem), comms and handoff records and alerts are redacted
// before they are committed, and backup.md says so instead of "not checked yet".
test("backup.md says what keeps relayed mail, handoffs and alerts from stopping a backup", () => {
  expect(text("docs/backup.md")).not.toContain("so no agent write can stop your backups");
  expect(text("docs/backup.md")).toContain("can't stop them either (G201)");
  expect(text("docs/backup.md")).toContain("(G280)");
});

test("CHANGELOG lists the belief radar once, with its stale-value and one-line rules", () => {
  const lines = text("CHANGELOG.md").split("\n").filter((l) => l.startsWith("- Belief radar:"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("no terminal escapes");
});
