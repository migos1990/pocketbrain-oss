// SPDX-License-Identifier: AGPL-3.0-only
// Conflicts wait for the Gardener (docs/filing.md, G416): a conflict filed from a capture
// carries `gardener_first` (when it opened) and waits until the Gardener suggests a side, until a
// pass of it read the open conflicts after this one opened (it looked and had nothing), or 36
// hours. Nobody else decides it meanwhile: not the resolver either. Whether one asks the owner at
// once for its shape (money, health, legal, private) is src/textline/items.ts.
import { join } from "node:path";
import { readJsonl } from "./util";
import { gardeners, type Rules } from "./rules";

export const GARDENER_WAIT_H = 36;
export type GardenerReads = () => { at: string; ids: string[] }[];
export interface HeldShape { fact_key: string; status: string; suggestion?: unknown; gardener_first?: string; gardener_seen?: string }

// A pass that read the conflict is stamped on its packet (`gardener_seen`, committed with the brain),
// so the release survives a restore and never depends on a local log (owner's re-audit, 2026-10-25;
// G425). The reads log still counts for packets stamped before that.
export function pendingGardener(d: HeldShape, seen: GardenerReads, now: Date): boolean {
  const first = d.gardener_first;
  if (typeof first !== "string" || d.status !== "open" || d.suggestion) return false;
  if (now.getTime() - Date.parse(first) >= GARDENER_WAIT_H * 3600_000) return false;
  if (typeof d.gardener_seen === "string" && d.gardener_seen >= first) return false;
  const id = d.fact_key.split("#")[0];
  return !seen().some((r) => r.at >= first && r.ids.includes(id));
}

// The Gardener's open_disputes reads (log/reads.jsonl), read once and only when asked.
export function gardenerSeen(root: string, rules: Rules): GardenerReads {
  let rows: { at: string; ids: string[] }[] | undefined;
  return () => rows ??= (() => {
    const g = new Set(gardeners(rules));
    return readJsonl<{ at?: unknown; agent?: unknown; op?: unknown; ids?: unknown }>(join(root, "log", "reads.jsonl"))
      .filter((r) => r.op === "open_disputes" && g.has(String(r.agent)) && typeof r.at === "string").map((r) => ({ at: String(r.at), ids: Array.isArray(r.ids) ? r.ids.map(String) : [] }));
  })();
}
