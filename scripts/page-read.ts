// SPDX-License-Identifier: AGPL-3.0-only
// One read of every page the owner has, as he sees it: how many odd sentences the nightly read's
// rules find, and how long each page takes to render. `deploy go` runs it on the real brain before
// and after it changes the code and prints the difference, so a change that makes pages read worse
// or render slower is seen at deploy time, not on the owner's phone (G984). It prints counts and
// milliseconds only, never a page's id, title or words. It writes no page, commit, log or heartbeat;
// like every reader of a brain it may refresh the parse cache under .cells/ (derived, never in git).
//   bun scripts/page-read.ts --brain <dir> [--json]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pageReadLine, pageReadOf, readPages } from "../src/proofread";

const i = Bun.argv.indexOf("--brain");
const brain = i >= 0 ? Bun.argv[i + 1] : process.env.PB_BRAIN;
if (!brain || !existsSync(join(brain, "rules"))) { console.error("usage: bun scripts/page-read.ts --brain <dir> [--json]"); process.exit(2); }
const { read, ms } = readPages(brain);
const r = pageReadOf(read, ms);
console.log(Bun.argv.includes("--json") ? JSON.stringify(r) : pageReadLine(r));
