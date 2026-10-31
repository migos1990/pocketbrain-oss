// SPDX-License-Identifier: AGPL-3.0-only
// How many held receipt pages the next upkeep would set aside (src/receipt-pages.ts), read-only,
// a count only: bun scripts/receipt-pages.ts <brain>
import { loadBrain } from "../src/brain";
import { receiptPages } from "../src/receipt-pages";
import { readDiary } from "../src/diary";

const root = process.argv[2];
if (!root) { console.error("usage: bun scripts/receipt-pages.ts <brain>"); process.exit(2); }
console.log(`receipt pages upkeep would set aside: ${receiptPages(loadBrain(root), new Set(readDiary(root).filter((r) => r.why === "receipt").map((r) => r.fact_key.slice(0, r.fact_key.lastIndexOf("#"))))).length}`);
