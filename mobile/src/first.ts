// SPDX-License-Identifier: AGPL-3.0-only
// Which screen an app opens on (docs/phone-app.md, First run). A paired phone opens its brain; an
// unpaired one first asks whether pocketBrain is on a computer yet, so someone with no hub isn't
// left on a pair screen with nothing to pair. Pure, so the hub's test run checks it.
import { PHONE_LINK_COMMAND } from "./commands";

export type Choice = "have" | "not-yet";
export type First = "page" | "welcome" | "steps" | "pair";

export const INSTALL_COMMAND = "curl -fsSL https://pocketbrain.dev/install.sh | sh";
export const INIT_COMMAND = "pocketbrain init";
export const SITE = "https://pocketbrain.dev";

export function firstScreen(hub: string | null, choice: Choice | undefined): First {
  if (hub) return "page";
  if (choice === "have") return "pair";
  if (choice === "not-yet") return "steps";
  return "welcome";
}

// What "Send these steps to my computer" hands the phone's share sheet; we send nothing ourselves.
export function shareText(): string {
  return [
    "Set up pocketBrain on this computer (Mac, Linux, or Windows with WSL):",
    `1. In Terminal, paste: ${INSTALL_COMMAND}`,
    `2. Then run: ${INIT_COMMAND}`,
    `3. When it's done, run: ${PHONE_LINK_COMMAND}`,
    "   and paste the link it prints into the pocketBrain app on your phone.",
    SITE,
  ].join("\n");
}
