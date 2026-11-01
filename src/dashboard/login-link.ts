// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The sign-in links of this run (they hold the reusable login key) go to a file in the brain's
// .git folder only the owner can read, never to the hub's output: launchd writes that to
// ~/Library/Logs, created 0644 and kept by rotation (audit v10, G609). The menu bar's Open
// dashboard reads the local one from here. A restart makes a new key and a new file.
export const loginLinkFile = (root: string) => join(root, ".git", "pb-dashboard-login");
export function keepLoginLinks(root: string, links: { local: string; tailnet?: string; serve?: string }): string | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  const f = loginLinkFile(root), tmp = `${f}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(links)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
  return f;
}
// The local link this run kept (`menubar open-dashboard`), or none.
export function readLoginLink(root: string): string | null {
  try { const l = (JSON.parse(readFileSync(loginLinkFile(root), "utf8")) as { local?: unknown }).local; return typeof l === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/login\?key=[A-Za-z0-9_-]+$/.test(l) ? l : null; } catch { return null; }
}
// What the hub says about signing in: the address and where the link is kept, never the key.
export function loginWords(file: string | undefined, local: string, tailnet?: string, serve?: string): string {
  const bare = (u: string) => u.replace(/\/login\?key=.*$/, "/");
  const where = file ? `sign-in link in ${file} (only you can read it; the menu bar's Open dashboard uses it)` : "no .git folder here, so no sign-in link is kept: run pocketbrain dashboard in a terminal";
  return [`owner dashboard (this machine only): ${bare(local)}; ${where}`, ...(tailnet ? [`owner dashboard on your tailnet (your devices only): ${bare(tailnet)}; a phone signs in with pocketbrain dashboard phone-link`] : []), ...(serve ? [`  or over https: ${bare(serve)}`] : [])].join("\n");
}

