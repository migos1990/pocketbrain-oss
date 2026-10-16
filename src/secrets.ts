// SPDX-License-Identifier: AGPL-3.0-only
// Keys for the brain's own model steps and the relay, for a hub started by launchd (or systemd),
// which has no shell environment: one file per key in ~/.config/pocketbrain/keys/, named after
// its variable (ANTHROPIC_API_KEY, TYPESAFE_API_KEY…), holding only the key. A file readable by
// anyone but its owner is ignored. The environment always wins. Values are never printed; only
// the names of the keys that were found.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const keysDir = () => join(process.env.PB_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pocketbrain"), "keys");

export function loadKeys(dir = keysDir()): { loaded: string[]; ignored: string[] } {
  const out = { loaded: [] as string[], ignored: [] as string[] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || process.env[name]) continue;
    const f = join(dir, name);
    const st = statSync(f);
    if (!st.isFile()) continue;
    if (st.mode & 0o077) { out.ignored.push(`${name} (readable by others; chmod 600 ${f})`); continue; }
    const v = readFileSync(f, "utf8").trim();
    if (!v || /\s/.test(v)) { out.ignored.push(`${name} (empty or more than one line)`); continue; }
    process.env[name] = v;
    out.loaded.push(name);
  }
  return out;
}
