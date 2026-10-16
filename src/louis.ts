// SPDX-License-Identifier: AGPL-3.0-only
// Louis's own messages, the strongest authority in the brain (rank 5). An agent can't make
// one up: a write that cites a Louis message id not in this registry goes to Louis instead
// of into the brain (eval gap G1). The registry lives in rules/, which only Louis edits;
// accepting a proposal from the inbox registers the ids it cites.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { git } from "./git";
import { today } from "./brain";
import { readYaml } from "./rules";
import { OWNER } from "./owner";
import { readJsonl, appendJsonl } from "./util";

interface Registry { messages: { id: string; added: string; note?: string }[] }
// rules/owner-messages.yaml; a brain started before the rename keeps rules/louis-messages.yaml.
const LEGACY = "rules/louis-messages.yaml";
export const ownerMessagesPath = (root: string) => existsSync(join(root, LEGACY)) ? LEGACY : "rules/owner-messages.yaml";
const file = (root: string) => join(root, ownerMessagesPath(root));

function load(root: string): Registry {
  return readYaml<Registry>(file(root), { messages: [] });
}

export function louisMessages(root: string): Set<string> {
  return new Set(load(root).messages.map((m) => m.id));
}

export function registerLouisMessages(root: string, ids: string[], note?: string, author = OWNER): number {
  const reg = load(root);
  const have = new Set(reg.messages.map((m) => m.id));
  const add = [...new Set(ids)].filter((id) => !have.has(id));
  if (!add.length) return 0;
  for (const id of add) reg.messages.push({ id, added: today(), ...(note ? { note } : {}) });
  writeFileSync(file(root), "# The owner's real message ids. Only the owner adds to this file (pocketbrain louis --msg, or accepting a proposal).\n" + YAML.stringify(reg, { lineWidth: 0 }));
  const rel = ownerMessagesPath(root);
  git(root, ["add", rel]);
  git(root, ["commit", "-q", "-m", `${author}: register ${add.length} owner message id(s)`, "--", rel], author);
  return add.length;
}

// Exact source refs (Gmail, calendar) confirmed to exist by a connector inside the wall,
// one JSON line each: {"ref":"gmail:…","ok":true,"at":"…"} (eval gap G2). Written by upkeep's
// live sources or `pocketbrain refs --load`. With no file, refs are checked for shape only.
export function checkedRefs(root: string): Map<string, boolean> | undefined {
  const f = join(root, "log", "refs-checked.jsonl");
  if (!existsSync(f)) return undefined;
  const m = new Map<string, boolean>();
  for (const o of readJsonl<{ ref: string; ok?: boolean }>(f)) m.set(o.ref, !!o.ok);
  return m;
}

export function recordCheckedRefs(root: string, results: Record<string, boolean>) {
  const f = join(root, "log", "refs-checked.jsonl");
  const at = new Date().toISOString();
  for (const [ref, ok] of Object.entries(results)) appendJsonl(f, { ref, ok, at });
}
