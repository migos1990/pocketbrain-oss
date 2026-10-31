// SPDX-License-Identifier: AGPL-3.0-only
// A rules/ file edited outside git is named in full on the home page, the deck, the text and the
// digest. git() trims its output, so the first status line lost its leading space and a fixed
// three-character cut showed "ules/policy.yaml" (seen on the dashboard, 2026-10-25).
import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { openItems } from "../src/textline/items";
import { digest } from "../src/digest";
import { porcelainPath } from "../src/git";

test("porcelain lines give their whole path, with or without the leading space", () => {
  expect(porcelainPath("M rules/policy.yaml")).toBe("rules/policy.yaml");
  expect(porcelainPath(" M rules/policy.yaml")).toBe("rules/policy.yaml");
  expect(porcelainPath("?? rules/new.yaml")).toBe("rules/new.yaml");
  expect(porcelainPath("MM rules/a.yaml")).toBe("rules/a.yaml");
});

test("a rules/ edit outside git is named in full on the owner's cards and in the digest", () => {
  const root = makeBrain();
  appendFileSync(join(root, "rules", "policy.yaml"), "\n# edited by hand\n");
  const item = openItems(root).find((i) => i.kind === "rules")!;
  expect(item.title).toContain("rules/policy.yaml");
  expect(item.title).not.toMatch(/(^|[^/a-z])ules\//);
  const out = digest(root).text;
  expect(out).toContain("rules/policy.yaml");
  expect(out).not.toMatch(/(^|[^/a-z])ules\//);
});
