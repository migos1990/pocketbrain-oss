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

// Exact source refs (Gmail, calendar) the hub read at their source, one JSON line each:
// {"ref":"gmail:…","ok":true,"at":"…"} (eval gap G2). Written by the hub whenever it reads an
// item (a source pull, verify_source, a recheck: src/pull.ts) and by `pocketbrain refs --load`.
// Always on (outside review 2026-10-25, G417): with no file nothing is checked yet, so an exact
// ref the hub never read can't replace a live value; before, no file meant no check at all.
export function checkedRefs(root: string): Map<string, boolean> {
  const f = join(root, "log", "refs-checked.jsonl");
  const m = new Map<string, boolean>();
  if (!existsSync(f)) return m;
  for (const o of readJsonl<{ ref: string; ok?: boolean }>(f)) m.set(o.ref, !!o.ok);
  return m;
}

// `from`: the hash of the address a read item came from (sameperson.ts senderHash), never the
// address in plain text (an unsalted hash: a phone number could be guessed back from it). A read mail vouches for that one address only (audit v11, G643).
export function recordCheckedRefs(root: string, results: Record<string, boolean>, from: Record<string, string | undefined> = {}) {
  const f = join(root, "log", "refs-checked.jsonl");
  const at = new Date().toISOString();
  for (const [ref, ok] of Object.entries(results)) appendJsonl(f, { ref, ok, at, ...(ok && from[ref] ? { from: from[ref] } : {}) });
}

// The sender hash each ref was last read with; a ref whose latest line has none (read before G643,
// or found missing) has no entry, so it vouches for no address.
export function checkedSenders(root: string): Map<string, string> {
  const f = join(root, "log", "refs-checked.jsonl");
  const m = new Map<string, string>();
  if (!existsSync(f)) return m;
  for (const o of readJsonl<{ ref: string; ok?: boolean; from?: unknown }>(f)) {
    if (o.ok && typeof o.from === "string") m.set(o.ref, o.from); else m.delete(o.ref);
  }
  return m;
}
