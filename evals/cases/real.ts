// SPDX-License-Identifier: AGPL-3.0-only
// Cases on a copy of Robin's real brain ($PB_BRAIN). Nothing here is committed with his data:
// expectations come from his rules/ at run time, and reports name fact keys, never values.
import type { Case } from "../lib/case";
import { ok, na } from "../lib/case";
import { realBrainPath, sandbox, TODAY } from "../lib/sandbox";
import { loadPB } from "../lib/pb";
import { leakScan, syncReplay } from "./components";

export function realCases(): Case[] {
  const has = !!realBrainPath();
  const skip = async () => na("PB_BRAIN not set");
  return [
    { id: "real-views-no-leak", dimension: "carving", title: "real brain: no carved fact value in any agent's view", kind: "attack", source: "real",
      run: has ? async () => leakScan(sandbox("real")) : skip },
    { id: "real-sync-replay", dimension: "idempotency", title: "real brain: every owner replaying every fact it holds is a no-op", source: "real", gap: "G12",
      run: has ? async () => syncReplay(sandbox("real")) : skip },
    { id: "real-upkeep-load", dimension: "upkeep", title: "real brain: today's upkeep run fits in Robin's 10-minute digest (under 25 items)", source: "real",
      run: has ? async () => {
        const pb = await loadPB();
        if (!pb.upkeep) return na("no upkeep at this commit");
        const r = pb.upkeep.upkeep(sandbox("real"), { now: TODAY });
        const by = new Map<string, number>();
        for (const f of r.findings) by.set(f.rule, (by.get(f.rule) ?? 0) + 1);
        const review = r.findings.filter((f: any) => f.kind !== "auto-fix").length;
        return ok(review <= 25, `${review} items for Robin (${[...by].map(([k, v]) => `${k} ${v}`).join(", ")})`, { findings: r.findings.length, review });
      } : skip },
  ];
}
