// SPDX-License-Identifier: AGPL-3.0-only
// Test and eval runs use a git config of their own, never the machine's: a developer's or a cloud
// container's global config (commit signing through a helper, hooks, a default branch) otherwise
// leaks into every temp brain, and a signer that's busy or missing fails commits that have nothing
// to do with the test (backlog #278). Child processes inherit it through the environment.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG = "[user]\n\tname = pocketbrain-test\n\temail = test@pocketbrain.local\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n";

export function isolateGit(dir: string): void {
  if (process.env.PB_GIT_ISOLATED) return;
  const file = join(dir, "gitconfig");
  writeFileSync(file, CONFIG);
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.PB_GIT_ISOLATED = file;
}
