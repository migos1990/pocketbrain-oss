// SPDX-License-Identifier: AGPL-3.0-only
// Loads the prototype under test. PB_SRC points at a src/ folder (default: this repo's),
// so the same suite can run against any commit checked out in a worktree (--backfill).
// A module that doesn't exist at that commit loads as undefined and its cases score n/a.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const SRC = resolve(process.env.PB_SRC ?? join(import.meta.dir, "..", "..", "src"));

async function opt(name: string): Promise<any> {
  const f = join(SRC, name);
  if (!existsSync(f)) return undefined;
  return await import(f);
}

export interface PB {
  brain: any;
  rules: any;
  carve: any;
  view: any;
  write: any;
  checks: any;
  relay?: any;
  upkeep?: any;
  freshness?: any;
  pull?: any;
  memsync?: any;
  google?: any;
  feeds?: any;
}

let cached: PB | undefined;
export async function loadPB(): Promise<PB> {
  if (cached) return cached;
  cached = {
    brain: await opt("brain.ts"),
    rules: await opt("rules.ts"),
    carve: await opt("carve.ts"),
    view: await opt("view.ts"),
    write: await opt("write.ts"),
    checks: await opt("checks.ts"),
    relay: await opt("relay.ts"),
    upkeep: await opt("upkeep.ts"),
    freshness: await opt("freshness.ts"),
    pull: await opt("pull.ts"),
    memsync: await opt("memsync.ts"),
    google: await opt("google.ts"),
    feeds: await opt("feeds.ts"),
  };
  return cached;
}
