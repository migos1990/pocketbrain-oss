// SPDX-License-Identifier: AGPL-3.0-only
// The tools the suite needs (backlog #278). A machine missing one used to show it as a handful
// of scattered failures or silent skips that every gate learned to excuse; now `test/setup.ts`
// stops the run up front with one line naming each missing tool and how to get it.
// PB_TEST_ALLOW_MISSING=<name,...> lets a run go on without them; their tests then skip, and the
// merge gate refuses any run with a skip.
import { existsSync } from "node:fs";

export const TOOLS: { name: string; why: string; install: string; present: () => boolean }[] = [
  { name: "ssh-keygen", why: "signed hub commits", install: "apt install openssh-client (macOS has it)", present: () => onPath("ssh-keygen") },
  { name: "age", why: "encrypted backups", install: "brew install age, or apt install age", present: () => onPath("age") && onPath("age-keygen") },
  { name: "ffmpeg", why: "the video montage tests", install: "brew install ffmpeg, or apt install ffmpeg", present: () => onPath("ffmpeg") && onPath("ffprobe") },
  { name: "python3", why: "the Python Memory Passport server's conformance run", install: "apt install python3 (macOS has it with the command line tools)", present: () => onPath("python3") },
  { name: "chromium", why: "the dashboard and UI tests", install: "bunx playwright install chromium", present: chromium },
];

function onPath(cmd: string): boolean {
  return Bun.which(cmd, { PATH: process.env.PATH ?? "" }) !== null;
}

function chromium(): boolean {
  try { return existsSync(require("playwright").chromium.executablePath()); } catch { return false; }
}

// GitHub's CI doesn't install ffmpeg yet: that line in .github/workflows/ci.yml waits for the owner
// (branch claude/zero-noise-ci). Until it lands, a CI run may go without ffmpeg; nowhere else.
const CI_ALLOWED = process.env.GITHUB_ACTIONS === "true" ? "ffmpeg" : "";

export function missingTools(allow = [process.env.PB_TEST_ALLOW_MISSING ?? "", CI_ALLOWED].join(",")): string[] {
  const ok = new Set(allow.split(",").map((s) => s.trim()).filter(Boolean));
  return TOOLS.filter((t) => !ok.has(t.name) && !t.present()).map((t) => `${t.name} (for ${t.why}): ${t.install}`);
}
