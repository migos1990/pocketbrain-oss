// SPDX-License-Identifier: AGPL-3.0-only
// Builder final slice audit of the stack (tree 3e8b28a9, 2026-11-01), G1 and G2 (G593): the page-scoped date scrub ran before links were redacted, and it skipped only granted values, not the dates the page grants beside them.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { readNote } from "../src/core";

const ID = "projects/product-discovery-course";
const SECRET = `---\nid: projects/2026-12-08-kickoff\ntype: project\ntitle: Secret kickoff\narea: teaching\nsensitivity: secret\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-01\nby: owner\n---\nx\n`;
// `due` hidden from claude by share_with (every role, cells and export alike).
async function body(due: string, text: string, extra?: (root: string) => void) {
  const { root } = await makeDemoBrain();
  extra?.(root);
  const f = join(root, `${ID}.md`);
  writeFileSync(f, readFileSync(f, "utf8")
    .replace("  due:\n    value: 2026-12-08\n", `  due:\n    value: ${due}\n    share_with: [chatgpt]\n`)
    .replace("(Written by the hub", `${text}\n\n(Written by the hub`));
  const out = JSON.stringify(readNote(root, "claude", ID));
  expect(out).not.toContain('"due"');
  return out;
}

test("G1: a link to a hidden note whose id holds the hidden date answers [[redacted]], never part of its id", async () => {
  const out = await body("2026-12-08", "See [[projects/2026-12-08-kickoff]].", (root) => writeFileSync(join(root, "projects/2026-12-08-kickoff.md"), SECRET));
  expect(out).toContain("See [[redacted]].");          // at e73e257b: "See [[projects/[withheld]-kickoff]]."
  expect(out).not.toContain("-kickoff");
}, 120_000);

test("G2: a granted source date (a visible fact's as_of, its writer footnote) answers the same whatever the hidden date is", async () => {
  // Every demo fact on the page has as_of 2026-09-27; the writer's footnotes read "Email, 2026-09-27 (...)".
  const line = (s: string) => s; // the whole answer, references and all
  const same = line(await body("2026-09-27", ""));
  const other = line(await body("2026-09-28", ""));
  expect(same).toBe(other);                              // at e73e257b: "Email, [withheld] (...)" vs "Email, 2026-09-27 (...)"
}, 120_000);

// Security review of stack 218be2db (G594): "a hidden date stays readable when the page grants the
// same date" is an active oracle. A writer adds a fact holding a candidate date and watches whether
// the hidden date's sentence comes back. The hidden fact's own sentence is withheld whatever the
// page grants.
test("G594: the hidden fact's own sentence stays withheld whatever dates the page grants", async () => {
  const line = async (granted: string) => {
    const { root } = await makeDemoBrain();
    const f = join(root, `${ID}.md`);
    writeFileSync(f, readFileSync(f, "utf8")
      .replace("  due:\n    value: 2026-12-08\n", "  due:\n    value: 2026-12-08\n    share_with: [chatgpt]\n")
      .replace("facts:\n", `facts:\n  probe:\n    items:\n      - value: ${granted}\n        as_of: 2026-09-27\n        sources:\n          - gmail:000000000000d02c\n        verification: self-reported\n        by: claude\n        recorded: 2026-09-27\n`));
    const body = (readNote(root, "claude", ID) as { body: string }).body;
    return body.slice(0, body.indexOf("(Written by the hub"));
  };
  const hit = await line("2026-12-08"), miss = await line("2026-12-09");
  expect(hit).not.toContain("8 Dec");
  expect(hit).toBe(miss);
}, 120_000);
