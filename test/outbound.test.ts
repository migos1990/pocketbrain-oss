// SPDX-License-Identifier: AGPL-3.0-only
// Backs the privacy promise "pocketBrain sends nothing to us": every host src/ names in a URL is
// listed, with its reason, in scripts/outbound-hosts.txt. A new one fails here until the owner adds it.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ALWAYS = (h: string) => h === "localhost" || /^127\./.test(h) || /(^|\.)example$/.test(h);

export function hostsIn(src: string): Set<string> {
  const out = new Set<string>();
  for (const line of src.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)/gi)) {
      const h = m[1].toLowerCase();
      if (!ALWAYS(h)) out.add(h);
    }
  }
  return out;
}

const allowed = new Set(readFileSync(join(ROOT, "scripts/outbound-hosts.txt"), "utf8").split("\n")
  .map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
const used = new Map<string, string>();
for (const f of readdirSync(join(ROOT, "src"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")))
  for (const h of hostsIn(readFileSync(join(ROOT, "src", f), "utf8"))) used.set(h, `src/${f}`);

test("hostsIn finds URL hosts, skips comment lines and loopback", () => {
  expect([...hostsIn('fetch("https://api.new.io/x")\n// http://evil.io\nconst u = "http://127.0.0.1:8787"')]).toEqual(["api.new.io"]);
});

test("every host src/ names is in scripts/outbound-hosts.txt", () => {
  const unknown = [...used].filter(([h]) => !allowed.has(h)).map(([h, f]) => `${h} (${f})`);
  expect(unknown).toEqual([]);
});

test("scripts/outbound-hosts.txt has no stale entries", () => {
  expect([...allowed].filter((h) => !used.has(h))).toEqual([]);
});
