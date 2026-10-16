// SPDX-License-Identifier: AGPL-3.0-only
// Memory import (docs/memory-sync.md, "Bringing memory in"): what an assistant already remembers
// (Claude Code's memory files, a claude.ai memory export, Town's or Instinct's answer to "what do
// you remember?") and the owner's own notes become proposals in the inbox. It is the capture
// pipeline (src/capture.ts) with a different origin, so nothing new decides anything:
// - each chunk is stored as a capture (secrets removed, injection shapes held for the owner, the
//   same text twice is a no-op), then a model lists candidate facts with their quotes;
// - deterministic checks drop what the text doesn't say and compare the rest with the brain:
//   known values are skipped, changes and new facts become proposals naming the old value;
// - an agent's memory is cited as that agent's observation (self-reported), never the owner's
//   word; the owner's own notes are the owner's word. Nothing is committed until the owner accepts.
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";
import { loadRules, ownerName } from "./rules";
import { capture, captureConfig, type CaptureResult } from "./capture";
import { memoryFiles, chunks } from "./memsync";
import type { Model } from "./model";

export const ME = "me";

// Markdown and text as they are; JSON (a memory export) as its string values, one per line.
export function readMemory(paths: string[]): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const add = (p: string) => {
    if (!existsSync(p)) return;
    // Inside a folder, links are skipped (G76): one could point at the brain itself.
    if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) if (!n.startsWith(".") && !lstatSync(join(p, n)).isSymbolicLink()) add(join(p, n)); return; }
    const raw = readFileSync(p, "utf8");
    if (/\.json$/i.test(p)) {
      const lines: string[] = [];
      const walk = (v: unknown) => { if (typeof v === "string") { if (v.trim()) lines.push(v.trim()); } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
      try { walk(JSON.parse(raw)); } catch { lines.push(raw); }
      out.push({ name: basename(p), text: lines.join("\n") });
    } else if (/\.(md|markdown|txt)$/i.test(p)) out.push({ name: basename(p), text: raw });
  };
  for (const p of paths) add(p.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
  return out.filter((x) => x.text.trim());
}

// `who` is an agent in policy.yaml or "me". Without paths, an agent's own memory.files are read.
export async function importMemory(root: string, who: string, paths: string[], model?: Model): Promise<{ name: string; result: CaptureResult }[]> {
  const rules = loadRules(root);
  if (who !== ME && !rules.policy.agents[who]) throw new Error(`no agent ${who} in policy.yaml (or use "${ME}" for ${ownerName(rules)}'s own notes)`);
  const files = paths.length ? paths : who === ME ? [] : memoryFiles(rules, who);
  if (!files.length) throw new Error(who === ME ? "give the files or folders of your notes" : `give ${who}'s memory files, or set memory.files for it in policy.yaml`);
  const max = captureConfig(rules).max_bytes;
  const out: { name: string; result: CaptureResult }[] = [];
  for (const f of readMemory(files)) {
    for (const [i, text] of chunks(f.text, max).entries()) {
      const result = await capture(root, { kind: "text", text }, model, who === ME ? { via: "cli" } : { agent: who, via: "import" });
      out.push({ name: chunks(f.text, max).length > 1 ? `${f.name} part ${i + 1}` : f.name, result });
    }
  }
  return out;
}
